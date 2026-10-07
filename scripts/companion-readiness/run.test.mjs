import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, realpath, rename, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { runCompanionReadiness, DEFAULT_PIN, FOCUSED_ARGS, MOBILE_SUITE_ARGS, pnpmInvocation } from './run.mjs';

const SESSION = 'test-session';
const ENVIRONMENT = 'test-environment';

test('missing runtime identifiers fail closed before commands', async (t) => {
  const f = await fixture(t);
  const admission = JSON.parse(await readFile(f.admissionPath, 'utf8'));
  admission.host = {};
  await writeFile(f.admissionPath, JSON.stringify(admission));
  const fake = fakeCommands({});
  await assert.rejects(run(f, fake, {}, { env: {} }), /session|environment|binding/i);
  assert.equal(fake.calls.length, 0);
});

test('explicit local binding works without claiming a platform environment ID', async (t) => {
  const f = await fixture(t);
  const admission = JSON.parse(await readFile(f.admissionPath, 'utf8'));
  admission.host = { session_id: SESSION, environment_id: null, environment_binding: 'synthetic-local-binding' };
  await writeFile(f.admissionPath, JSON.stringify(admission));
  const fake = fakeCommands({});
  const result = await run(f, fake, {}, { env: { CODEX_SESSION_ID: SESSION, CODEX_ENVIRONMENT_BINDING: 'synthetic-local-binding' } });
  assert.equal(result.host.environment_id, null);
  assert.equal(result.host.environment_binding, 'synthetic-local-binding');
});

test('cleanup target and logs bind the exact run ID', async (t) => {
  for (const field of ['target', 'logs_dir']) {
    const f = await fixture(t);
    const state = JSON.parse(await readFile(f.state, 'utf8'));
    state[field] += '-other-run';
    await mkdir(state[field], { recursive: true });
    await writeFile(f.state, JSON.stringify(state));
    const fake = fakeCommands({});
    await assert.rejects(run(f, fake), /run_id/);
    assert.equal(fake.calls.length, 0);
  }
});

test('escaping state junction refuses before commands', async (t) => {
  const f = await fixture(t);
  const stateDir = join(f.workspaceRoot, 'repair2/cleanup/state');
  const outside = join(f.workspaceRoot, 'outside-state');
  await rename(stateDir, outside);
  await symlink(outside, stateDir, process.platform === 'win32' ? 'junction' : 'dir');
  const fake = fakeCommands({});
  await assert.rejects(run(f, fake), /link|junction|canonical/);
  assert.equal(fake.calls.length, 0);
});

test('spawn error messages are redacted in both output sinks', async (t) => {
  const f = await fixture(t);
  const fake = fakeCommands({});
  const marker = 'synthetic-message-marker';
  const execute = async (file, args, options) => {
    if (file === 'pnpm' && args[0] === 'install') throw new Error(`https://user:${marker}@github.com/example Authorization: Bearer ${marker}`);
    return fake.execute(file, args, options);
  };
  await assert.rejects(run(f, { execute }), /frozen-install failed/);
  const receiptText = await readFile(join(f.artifacts, 'readiness-receipt.json'), 'utf8');
  const receipt = JSON.parse(receiptText);
  const command = receipt.commands.find((entry) => entry.label === 'frozen-install');
  assert.equal(receiptText.includes(marker), false);
  assert.equal((await readFile(command.log_path, 'utf8')).includes(marker), false);
  assert.match(command.spawn_error, /REDACTED/);
});

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

async function run(f, fake, options = {}, overrides = {}) {
  return runCompanionReadiness({ state: f.state, admission: f.admissionPath, ...options }, {
    execute: fake.execute, env, workspaceRoot: f.workspaceRoot, platform: 'linux', ...overrides,
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

async function pnpmFixture(t, version = '9.0.0') {
  const root = await mkdtemp(join(tmpdir(), 'pnpm-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cli = join(root, 'bin/pnpm.cjs');
  await mkdir(join(root, 'bin'), { recursive: true });
  await writeFile(cli, '/* synthetic pnpm CLI */\n');
  await writeFile(join(root, 'package.json'), JSON.stringify({
    name: 'pnpm', version, bin: { pnpm: 'bin/pnpm.cjs' },
  }));
  return { cli, admission: { toolchain: {
    node_path: process.execPath, pnpm_package_root: root, pnpm_cli_path: cli,
    pnpm_cli_sha256: createHash('sha256').update(await readFile(cli)).digest('hex'),
  } } };
}

test('pnpm invocation keeps POSIX resolution unchanged', async () => {
  assert.deepEqual(await pnpmInvocation({}, { platform: 'linux' }), { executable: 'pnpm', prefixArgs: [] });
});

test('Windows pnpm invocation binds Node and the admitted CLI without a shell', async (t) => {
  const f = await pnpmFixture(t);
  const invocation = await pnpmInvocation(f.admission, { platform: 'win32' });
  assert.equal(invocation.executable, await realpath(process.execPath));
  assert.deepEqual(invocation.prefixArgs, [await realpath(f.cli)]);
  assert.ok(!invocation.executable.toLowerCase().endsWith('.cmd'));
});

test('Windows pnpm invocation rejects missing, wrong-version, wrong-digest and wrong-bin bindings', async (t) => {
  await assert.rejects(pnpmInvocation({}, { platform: 'win32' }), /exact toolchain binding/);
  const wrongVersion = await pnpmFixture(t, '10.0.0');
  await assert.rejects(pnpmInvocation(wrongVersion.admission, { platform: 'win32' }), /pnpm package must be/);
  const wrongDigest = await pnpmFixture(t);
  wrongDigest.admission.toolchain.pnpm_cli_sha256 = '0'.repeat(64);
  await assert.rejects(pnpmInvocation(wrongDigest.admission, { platform: 'win32' }), /SHA-256 mismatch/);
  const wrongBin = await pnpmFixture(t);
  const root = wrongBin.admission.toolchain.pnpm_package_root;
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'pnpm', version: '9.0.0', bin: { pnpm: 'bin/other.cjs' } }));
  await assert.rejects(pnpmInvocation(wrongBin.admission, { platform: 'win32' }), /declare bin\/pnpm.cjs/);
});

test('Windows runner records the actual admitted Node and pnpm CLI for every pnpm stage', async (t) => {
  const f = await fixture(t);
  const binding = await pnpmFixture(t);
  const admission = JSON.parse(await readFile(f.admissionPath, 'utf8'));
  admission.toolchain = binding.admission.toolchain;
  await writeFile(f.admissionPath, JSON.stringify(admission));
  const fake = fakeCommands({});
  const actual = [];
  const cli = await realpath(binding.cli);
  const node = await realpath(process.execPath);
  const execute = async (file, args, options) => {
    actual.push({ file, args: [...args] });
    if (file === node && args[0] === cli) return fake.execute('pnpm', args.slice(1), options);
    if (file === node && args[0] === '--version') return fake.execute('node', args, options);
    return fake.execute(file, args, options);
  };
  const result = await run(f, { execute }, {}, { platform: 'win32' });
  for (const label of ['pnpm-version', 'frozen-install', 'focused-tests', 'mobile-suite']) {
    const command = result.commands.find((entry) => entry.label === label);
    assert.equal(command.executable, node);
    assert.equal(command.args[0], cli);
  }
  assert.ok(actual.every((call) => call.file !== 'cmd.exe' && !call.file.toLowerCase().endsWith('.cmd')));
});

const CANDIDATE_PIN = 'a'.repeat(40);

test('explicit candidate pin requires state, admission and HEAD to agree', async (t) => {
  const f = await fixture(t);
  const state = JSON.parse(await readFile(f.state, 'utf8'));
  state.pin = CANDIDATE_PIN;
  await writeFile(f.state, JSON.stringify(state));
  const admission = JSON.parse(await readFile(f.admissionPath, 'utf8'));
  admission.commit = CANDIDATE_PIN;
  await writeFile(f.admissionPath, JSON.stringify(admission));
  const result = await run(f, fakeCommands({ pin: CANDIDATE_PIN }), { pin: CANDIDATE_PIN });
  assert.equal(result.source.sha, CANDIDATE_PIN);
  assert.equal(result.result, 'passed');
});

test('explicit candidate pin rejects state and admission mismatches before commands', async (t) => {
  const stateMismatch = await fixture(t);
  const stateFake = fakeCommands({});
  await assert.rejects(run(stateMismatch, stateFake, { pin: CANDIDATE_PIN }), /cleanup state pin does not match/);
  assert.equal(stateFake.calls.length, 0);
  const admissionMismatch = await fixture(t);
  const state = JSON.parse(await readFile(admissionMismatch.state, 'utf8'));
  state.pin = CANDIDATE_PIN;
  await writeFile(admissionMismatch.state, JSON.stringify(state));
  const admissionFake = fakeCommands({ pin: CANDIDATE_PIN });
  await assert.rejects(run(admissionMismatch, admissionFake, { pin: CANDIDATE_PIN }), /admission commit mismatch/);
  assert.equal(admissionFake.calls.length, 0);
});

test('validation time never restarts the twenty-minute budget', async (t) => {
  const f = await fixture(t);
  const admission = JSON.parse(await readFile(f.admissionPath, 'utf8'));
  admission.expires_at_utc = new Date(Date.now() + 30 * 60 * 1000).toISOString();
  await writeFile(f.admissionPath, JSON.stringify(admission));
  const clock = Date.now();
  t.mock.method(Date, 'now', () => clock + 5_000);
  const receipt = await run(f, fakeCommands({}));
  assert.equal(receipt.deadline_ms, Date.parse(receipt.started_at_utc) + 20 * 60 * 1000);
});

test('explicit portable cleanup root must be bound to the same canonical root in admission', async (t) => {
  const f = await fixture(t);
  const cleanupRoot = join(f.workspaceRoot, 'repair2/cleanup');
  const admission = JSON.parse(await readFile(f.admissionPath, 'utf8'));
  admission.cleanup_root = cleanupRoot;
  await writeFile(f.admissionPath, JSON.stringify(admission));
  const result = await run(f, fakeCommands({}), { cleanupRoot });
  assert.equal(result.cleanup_root, cleanupRoot);
  assert.equal(result.result, 'passed');
});

test('explicit portable cleanup root rejects missing admission binding before source commands', async (t) => {
  const f = await fixture(t);
  const fake = fakeCommands({});
  await assert.rejects(run(f, fake, { cleanupRoot: join(f.workspaceRoot, 'repair2/cleanup') }), /bound in admission/);
  assert.equal(fake.calls.length, 0);
});

test('redaction preserves case-insensitive token coverage on the supported Node engines', async (t) => {
  const f = await fixture(t);
  const fake = fakeCommands({});
  const execute = async (file, args, options) => {
    if (file === 'pnpm' && args[0] === 'install') {
      return { stdout: 'AUTHORIZATION: BeArEr synthetic-secret\n_AUTHTOKEN=synthetic-secret\n', stderr: '' };
    }
    return fake.execute(file, args, options);
  };
  const receipt = await run(f, { execute });
  const log = await readFile(receipt.commands.find((c) => c.label === 'frozen-install').log_path, 'utf8');
  assert.ok(!log.includes('synthetic-secret'));
  assert.match(log, /Authorization: Bearer \[REDACTED\]/);
  assert.match(log, /_authToken=\[REDACTED\]/);
});
