import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { devNull, tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';
import Fastify from 'fastify';
import { Readable } from 'node:stream';
import type { AuthContext } from '../auth/bearer.js';
import { registerDeveloperGitReadRoutes, type DeveloperGitReadDependencies } from './developer-git-read.js';

const TEST_BEARER = 'fictional-local-git-test-bearer';

function localGitEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const safe: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'HOME', 'COMSPEC', 'PATHEXT']) {
    if (process.env[key]) safe[key] = process.env[key];
  }
  return { ...safe, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: devNull, GIT_TERMINAL_PROMPT: '0', ...extra };
}

function git(args: string[], cwd?: string, env: NodeJS.ProcessEnv = localGitEnv()): Buffer {
  return execFileSync('git', args, {
    cwd,
    encoding: 'buffer',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: localGitEnv(env),
  });
}

function gitAsync(args: string[], cwd: string | undefined, env: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = []; const err: Buffer[] = [];
    const timeout = setTimeout(() => child.kill(), 20_000);
    child.stdout.on('data', (chunk: Buffer) => out.push(Buffer.from(chunk)));
    child.stderr.on('data', (chunk: Buffer) => err.push(Buffer.from(chunk)));
    child.once('error', (error) => { clearTimeout(timeout); reject(error); });
    child.once('close', (code) => { clearTimeout(timeout); resolve({ code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') }); });
  });
}

async function bodyBuffer(body?: Readable): Promise<Buffer> {
  if (!body) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  for await (const chunk of body) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function runGitHttpBackend(input: {
  method: string;
  pathInfo: string;
  query: string;
  contentType: string;
  gitProtocol?: string;
  body: Buffer;
  projectRoot: string;
}): Promise<{ statusCode: number; contentType: string; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['http-backend'], {
      env: localGitEnv({
        GIT_PROJECT_ROOT: input.projectRoot,
        GIT_HTTP_EXPORT_ALL: '1',
        PATH_INFO: input.pathInfo,
        QUERY_STRING: input.query,
        REQUEST_METHOD: input.method,
        CONTENT_TYPE: input.contentType,
        CONTENT_LENGTH: String(input.body.length),
        REMOTE_USER: 'fictional-developer',
        GIT_PROTOCOL: input.gitProtocol,
      }),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(Buffer.from(chunk)));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(Buffer.from(chunk)));
    child.once('error', reject);
    child.once('close', (code) => {
      if (code !== 0) {
        reject(new Error(`local git-http-backend exited ${code}: ${Buffer.concat(stderr).toString('utf8')}`));
        return;
      }
      const output = Buffer.concat(stdout);
      const separator = output.indexOf(Buffer.from('\r\n\r\n'));
      const separatorSize = 4;
      const altSeparator = separator < 0 ? output.indexOf(Buffer.from('\n\n')) : -1;
      const index = separator >= 0 ? separator : altSeparator;
      if (index < 0) {
        reject(new Error('local git-http-backend omitted CGI headers'));
        return;
      }
      const delimiter = separator >= 0 ? separatorSize : 2;
      const headerText = output.subarray(0, index).toString('latin1');
      const contentType = /^content-type:\s*(.+)$/im.exec(headerText)?.[1]?.trim();
      const status = /^status:\s*(\d{3})/im.exec(headerText)?.[1];
      if (!contentType) {
        reject(new Error(`local git-http-backend omitted Content-Type: ${headerText}`));
        return;
      }
      resolve({
        statusCode: status ? Number(status) : 200,
        contentType,
        body: output.subarray(index + delimiter),
      });
    });
    child.stdin.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code !== 'EPIPE') reject(error);
    });
    child.stdin.end(input.body);
  });
}

test('Developer read route supports Git CLI clone and rejects push against a fictional local bare repo', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'developer-git-read-'));
  const bareRepo = join(scratch, 'iheartest.git');
  const sourceRepo = join(scratch, 'source');
  const cloneRepo = join(scratch, 'clone');
  const app = Fastify({ logger: false });
  const upstreamMethods: string[] = [];

  try {
    await mkdir(sourceRepo);
    git(['init', '--bare', '--initial-branch=main', bareRepo]);
    git(['init', '--initial-branch=main'], sourceRepo);
    git(['config', 'user.name', 'Synthetic Test'], sourceRepo);
    git(['config', 'user.email', 'synthetic@example.invalid'], sourceRepo);
    await writeFile(join(sourceRepo, 'README.txt'), 'FICTIONAL LOCAL FIXTURE ONLY\n');
    git(['add', 'README.txt'], sourceRepo);
    git(['commit', '-m', 'synthetic fixture'], sourceRepo);
    git(['remote', 'add', 'origin', bareRepo], sourceRepo);
    git(['push', 'origin', 'main'], sourceRepo);
    git(['--git-dir', bareRepo, 'symbolic-ref', 'HEAD', 'refs/heads/main']);

    const dependencies: DeveloperGitReadDependencies = {
      authenticate: async (request) => request.headers.authorization === `Bearer ${TEST_BEARER}`
        ? ({
            caller_agent: 'developer',
            caller_hash: 'a'.repeat(64),
            raw_token: 'synthetic-only',
            connector_surface: true,
            m365_static_auth: false,
          } satisfies AuthContext)
        : null,
      upstream: async (request) => {
        upstreamMethods.push(request.method);
        assert.match(request.url, /^https:\/\/github\.com\/InnerScopeHearing\/iheartest\.git\//);
        assert.equal(request.headers.authorization, undefined);
        assert.equal(request.headers.cookie, undefined);
        const url = new URL(request.url);
        const body = await bodyBuffer(request.body);
        const response = await runGitHttpBackend({
          method: request.method,
          pathInfo: url.pathname.replace(/^\/InnerScopeHearing/, ''),
          query: url.search.slice(1),
          contentType: request.headers['content-type'] ?? '',
          gitProtocol: request.headers['git-protocol'],
          body,
          projectRoot: scratch,
        });
        return {
          statusCode: response.statusCode,
          contentType: response.contentType,
          body: Readable.from([response.body]),
        };
      },
    };
    registerDeveloperGitReadRoutes(app, dependencies);
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const gitUrl = `${address}/developer/git/v1/iheartest`;
    const gitEnv = localGitEnv({
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'http.extraHeader',
      GIT_CONFIG_VALUE_0: `Authorization: Bearer ${TEST_BEARER}`,
      GIT_ALLOW_PROTOCOL: 'http',
    });

    const refs = await gitAsync(['ls-remote', gitUrl], undefined, gitEnv);
    assert.equal(refs.code, 0, refs.stderr);
    assert.match(refs.stdout, /refs\/heads\/main/);
    const cloned = await gitAsync(['clone', gitUrl, cloneRepo], undefined, gitEnv);
    assert.equal(cloned.code, 0, cloned.stderr);
    assert.equal(await readFile(join(cloneRepo, 'README.txt'), 'utf8'), 'FICTIONAL LOCAL FIXTURE ONLY\n');

    git(['config', 'user.name', 'Synthetic Test'], cloneRepo);
    git(['config', 'user.email', 'synthetic@example.invalid'], cloneRepo);
    await writeFile(join(cloneRepo, 'push-attempt.txt'), 'must never reach the bare repo\n');
    git(['add', 'push-attempt.txt'], cloneRepo);
    git(['commit', '-m', 'synthetic forbidden push'], cloneRepo);

    const pushed = await gitAsync(['-c', 'protocol.version=0', 'push', 'origin', 'HEAD:refs/heads/forbidden-test'], cloneRepo, gitEnv);
    assert.notEqual(pushed.code, 0, 'push must be rejected by the route');
    const refsAfterPush = git(['--git-dir', bareRepo, 'for-each-ref', '--format=%(refname)']).toString('utf8').trim().split(/\r?\n/);
    assert.deepEqual(refsAfterPush, ['refs/heads/main']);
    assert.ok(upstreamMethods.filter((method) => method === 'GET').length >= 2, 'Git CLI must discover refs');
    assert.ok(upstreamMethods.includes('POST'), 'Git CLI clone must use upload-pack');
  } finally {
    await app.close().catch(() => {});
    await rm(scratch, { recursive: true, force: true });
  }
});
