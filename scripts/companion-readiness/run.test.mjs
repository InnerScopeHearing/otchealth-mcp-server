import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCompanionReadiness, DEFAULT_PIN, FOCUSED_ARGS, MOBILE_SUITE_ARGS } from './run.mjs';

const SESSION = 'test-session';
const ENVIRONMENT = 'test-environment';

async function fixture(t, overrides = {}) {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'companion-runner-'));
  t.after(() => rm(workspaceRoot, { recursive: true, force: true }));
  const runId = 'synthetic-run';
  const repo = join(workspaceRoot, 'repair2/cleanup/worktrees', runId);
  const stateDir = join(workspaceRoot, 'repair2/cleanup/state');
  const artifacts = join(workspaceRoot, 'repair2/cleanup/artifacts', runId);
  const admissionPath = join(workspaceRoot, 'admission.json');
  await mkdir(join(repo, 'apps/mobile/src/boot'), { recursive: true });
  await mkdir(join(repo, 'apps/mobile/src/pages'), { recursive: true });
  await mkdir(stateDir, { recursive: true });
  await mkdir(artifacts, { recursive: true });
  await writeFile(join(repo, 'package.json'), JSON.stringify({
    name: 'otchealth-companion',
    packageManager: 'pnpm@9.0.0',
    engines: { node: '>=22' },
  }));
  await writeFile(join(repo, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n');
  await writeFile(join(repo, 'apps/mobile/src/boot/ErrorBoundary.test.tsx'), 'synthetic');
  await writeFile(join(repo, 'apps/mobile/src/pages/Settings.test.tsx'), 'synthetic');
  await writeFile(join(stateDir, `${runId}.json`), JSON.stringify({
    run_id: runId,
    repository: 'InnerScopeHearing/otchealth-companion',
    target: repo,
    pin: DEFAULT_PIN,
    logs_dir: artifacts,
  }));
  await writeFile(admissionPath, JSON.stringify({
    schema_version: 1,
    allowed: true,
    scope: 'companion-readiness',
    repository: 'InnerScopeHearing/otchealth-companion',
    commit: DEFAULT_PIN,
    task_id: 't_idem_2bde337b',
    host_binding_verified: true,
    task_approval_verified: true,
    source_acquisition_approved: true,
    dependency_install_route_approved: true,
    synthetic_tests_only: true,
    no_live_provider_calls: true,
    host: { session_id: SESSION, environment_id: ENVIRONMENT },
    expires_at_utc: new Date(Date.now() + 60_000).toISOString(),
  }));
  return { workspaceRoot, repo, artifacts, state: join(stateDir, `${runId}.json`), admissionPath, ...overrides };
}

function fakeCommands({ pin = DEFAULT_PIN, dirty = false, dirtyAfter = false, remote = 'https://github.com/InnerScopeHearing/otchealth-companion.git', pnpm = '9.0.0', node = 'v22.23.2', failing = null, timedOut = null } = {}) {
  const calls = [];
  let statusReads = 0;
  const execute = async (file, args, options) => {
    const key = `${file} ${args.join(' ')}`;
    calls.push({ file, args: [...args], cwd: options.cwd, env: options.env });
    if (timedOut === key) throw Object.assign(new Error('synthetic timeout'), { code: 'ETIMEDOUT', killed: true, stdout: '', stderr: '' });
    if (file === 'git' && args[0] === 'rev-parse' && args[1] === '--show-toplevel') return { stdout: options.cwd, stderr: '' };
    if (file === 'git' && args[0] === 'rev-parse' && args[1] === 'HEAD') return { stdout: `${pin}\n`, stderr: '' };
    if (file === 'git' && args[0] === 'remote') return { stdout: `${remote}\n`, stderr: '' };
    if (file === 'git' && args[0] === 'status') {
      statusReads += 1;
      return { stdout: (dirty && statusReads === 1) || (dirtyAfter && statusReads > 1) ? ' M apps/mobile/src/pages/Settings.tsx\n' : '', stderr: '' };
    }
    if (file === 'node' && args[0] === '--version') return { stdout: `${node}\n`, stderr: '' };
    if (file === 'pnpm' && args[0] === '--version') return { stdout: `${pnpm}\n`, stderr: '' };
    if (failing === key) throw Object.assign(new Error('synthetic command failure'), { code: 7, stdout: '', stderr: 'synthetic failure' });
    return { stdout: 'ok\n', stderr: '' };
  };
  return { execute, calls };
}

const env = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  CODEX_SESSION_ID: SESSION,
  CODEX_ENVIRONMENT_ID: ENVIRONMENT,
  AWS_ACCESS_KEY_ID: 'must-not-be-forwarded',
};

async function run(f, fake) {
  return runCompanionReadiness({ state: f.state, admission: f.admissionPath }, {
    execute: fake.execute, env, workspaceRoot: f.workspaceRoot,
  });
}

test('runs exact install, focused tests, and full mobile suite for a clean exact pin', async (t) => {
  const f = await fixture(t);
  const fake = fakeCommands({});
  const result = await run(f, fake);
  assert.equal(result.result, 'passed');
  assert.equal(result.source.sha, DEFAULT_PIN);
  assert.deepEqual(result.commands.filter((c) => c.label === 'frozen-install')[0].args, ['install', '--frozen-lockfile']);
  assert.deepEqual(result.commands.find((c) => c.label === 'focused-tests').args, FOCUSED_ARGS);
  assert.deepEqual(result.commands.find((c) => c.label === 'mobile-suite').args, MOBILE_SUITE_ARGS);
  assert.equal(result.restoration.source_diffs, 'none');
  assert.equal(result.restoration.lockfile_unchanged, true);
  assert.ok(!('AWS_ACCESS_KEY_ID' in fake.calls.at(-1).env));
  const logs = await readdir(f.artifacts);
  assert.ok(logs.includes('readiness-receipt.json'));
  assert.ok(logs.some((name) => name.endsWith('-focused-tests.log')));
});

test('wrong source pin fails before toolchain checks or package installation', async (t) => {
  const f = await fixture(t);
  const fake = fakeCommands({ pin: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' });
  await assert.rejects(run(f, fake), /source SHA mismatch/);
  assert.ok(!fake.calls.some((call) => call.file === 'pnpm'));
  const receipt = JSON.parse(await readFile(join(f.artifacts, 'readiness-receipt.json'), 'utf8'));
  assert.equal(receipt.result, 'blocked');
});

test('wrong cleanup state pin fails before any source command', async (t) => {
  const f = await fixture(t);
  const state = JSON.parse(await readFile(f.state, 'utf8'));
  state.pin = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  await writeFile(f.state, JSON.stringify(state));
  const fake = fakeCommands({});
  await assert.rejects(run(f, fake), /cleanup state pin does not match/);
  assert.equal(fake.calls.length, 0);
});

test('rejects remotes whose hostname merely contains github.com', async (t) => {
  const f = await fixture(t);
  const fake = fakeCommands({ remote: 'https://github.com.evil.example/InnerScopeHearing/otchealth-companion.git' });
  await assert.rejects(run(f, fake), /origin is not the expected Companion repository/);
  assert.equal(fake.calls.some((call) => call.file === 'pnpm'), false);
});

test('wrong pnpm version fails before frozen install', async (t) => {
  const f = await fixture(t);
  const fake = fakeCommands({ pnpm: '11.25.0' });
  await assert.rejects(run(f, fake), /pnpm 9\.0\.0 required/);
  assert.ok(!fake.calls.some((call) => call.args[0] === 'install'));
});

test('dirty prestate fails closed before toolchain and tests', async (t) => {
  const f = await fixture(t);
  const fake = fakeCommands({ dirty: true });
  await assert.rejects(run(f, fake), /prestate must have no tracked or visible untracked changes/);
  assert.equal(fake.calls.some((call) => call.file === 'pnpm'), false);
});

test('missing admission records a block and starts no commands', async (t) => {
  const f = await fixture(t);
  const fake = fakeCommands({});
  await assert.rejects(runCompanionReadiness({ state: f.state }, {
    execute: fake.execute, env, workspaceRoot: f.workspaceRoot,
  }), /--admission file is required/);
  assert.equal(fake.calls.length, 0);
  const receipt = JSON.parse(await readFile(join(f.artifacts, 'readiness-receipt.json'), 'utf8'));
  assert.equal(receipt.result, 'blocked');
  assert.match(receipt.blocked_reason, /fail closed/);
});

test('a failing focused command records numeric exit and skips the full suite', async (t) => {
  const f = await fixture(t);
  const failing = `pnpm ${FOCUSED_ARGS.join(' ')}`;
  const fake = fakeCommands({ failing });
  await assert.rejects(run(f, fake), (error) => error.exitCode === 7 && /focused-tests failed/.test(error.message));
  assert.ok(fake.calls.some((call) => call.args[0] === 'install'));
  assert.ok(fake.calls.some((call) => call.args[0] === '--filter' && call.args.includes('vitest')));
  assert.equal(fake.calls.some((call) => call.args.join(' ') === MOBILE_SUITE_ARGS.join(' ')), false);
  const receipt = JSON.parse(await readFile(join(f.artifacts, 'readiness-receipt.json'), 'utf8'));
  assert.equal(receipt.result, 'tests_failed');
  assert.equal(receipt.exit_code, 7);
  assert.equal(receipt.commands.find((command) => command.label === 'focused-tests').exit_code, 7);
});

test('post-command dirty state is recorded as restoration failure before returning failure', async (t) => {
  const f = await fixture(t);
  const fake = fakeCommands({ dirtyAfter: true });
  await assert.rejects(run(f, fake), /visible changes after commands/);
  const receipt = JSON.parse(await readFile(join(f.artifacts, 'readiness-receipt.json'), 'utf8'));
  assert.equal(receipt.result, 'restoration_failed');
  assert.equal(receipt.exit_code, 1);
});

test('a command timeout records exit 124 and stops the run', async (t) => {
  const f = await fixture(t);
  const key = `pnpm ${FOCUSED_ARGS.join(' ')}`;
  const fake = fakeCommands({ timedOut: key });
  await assert.rejects(run(f, fake), (error) => error.exitCode === 124 && /focused-tests failed/.test(error.message));
  const receipt = JSON.parse(await readFile(join(f.artifacts, 'readiness-receipt.json'), 'utf8'));
  const command = receipt.commands.find((entry) => entry.label === 'focused-tests');
  assert.equal(command.exit_code, 124);
  assert.equal(command.timed_out, true);
  assert.equal(receipt.result, 'tests_failed');
});
