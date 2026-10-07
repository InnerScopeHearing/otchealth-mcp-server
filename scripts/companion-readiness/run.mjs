#!/usr/bin/env node
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, readdir, realpath, lstat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

const execFileDefault = promisify(execFileCallback);
export const DEFAULT_REPOSITORY = 'InnerScopeHearing/otchealth-companion';
export const DEFAULT_PIN = '157973c73bdcef81856734cf82496760e85dc100';
export const EXPECTED_PACKAGE_MANAGER = 'pnpm@9.0.0';
export const FOCUSED_ARGS = [
  '--filter', 'mobile', 'exec', 'vitest', 'run',
  'src/boot/ErrorBoundary.test.tsx', 'src/pages/Settings.test.tsx',
];
export const MOBILE_SUITE_ARGS = ['--filter', 'mobile', 'test'];
export const FROZEN_INSTALL_ARGS = ['install', '--frozen-lockfile'];

const RUNNER_SCOPE = 'companion-readiness';
const RUNNER_VERSION = 1;
const MAX_RUN_MS = 20 * 60 * 1000;
const ALLOWED_REMOTE_HOSTS = new Set(['github.com', 'git.chatgpt-team.site']);
const SAFE_ENV_NAMES = [
  'PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'CI', 'LANG', 'LC_ALL', 'NO_COLOR',
];

function redact(text) {
  return String(text)
    .replace(/https?:\/\/[^/\s@]+@/g, 'https://[REDACTED]@')
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, '[REDACTED_GITHUB_TOKEN]')
    .replace(/authorization:\s*bearer\s+\S+/gi, 'Authorization: Bearer [REDACTED]')
    .replace(/_authToken=\S+/gi, '_authToken=[REDACTED]');
}

function safeEnv(source = process.env) {
  const result = {};
  for (const name of SAFE_ENV_NAMES) {
    if (source[name] !== undefined) result[name] = source[name];
  }
  result.CI = 'true';
  result.NO_COLOR = '1';
  return result;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function parseSha(value) {
  return typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
}

function inside(parent, child) {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

function samePath(left, right) {
  const a = resolve(left);
  const b = resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

async function canonicalNoLinks(path, allowMissing = false) {
  const absolute = resolve(path);
  let current = absolute;
  while (true) {
    try {
      const info = await lstat(current);
      assert(!info.isSymbolicLink(), 'symlink or junction path is not admitted');
      assert(samePath(await realpath(current), current), 'noncanonical linked path is not admitted');
    } catch (error) {
      if (!(allowMissing && error.code === 'ENOENT')) throw error;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return absolute;
}

function commandString(executable, args) {
  return [executable, ...args].map((part) => JSON.stringify(part)).join(' ');
}

function safePath(base, target) {
  return relative(resolve(base), resolve(target)).split(sep).join('/');
}

async function sha256(path) {
  const bytes = await readFile(path);
  return createHash('sha256').update(bytes).digest('hex');
}

async function runOne(execute, receipt, { executable, args, cwd, label, env, logDir }) {
  const startedAt = new Date().toISOString();
  let stdout = '';
  let stderr = '';
  let exitCode = 0;
  let spawnError = null;
  let timedOut = false;
  try {
    const remaining = receipt.deadline_ms ? receipt.deadline_ms - Date.now() : MAX_RUN_MS;
    assert(remaining > 0, 'admission/stage time budget expired');
    const timeout = Math.max(1, Math.min(MAX_RUN_MS, remaining));
    const result = await execute(executable, args, { cwd, env, maxBuffer: 50 * 1024 * 1024, windowsHide: true, timeout });
    stdout = result?.stdout ?? '';
    stderr = result?.stderr ?? '';
    exitCode = Number.isInteger(result?.exitCode) ? result.exitCode : 0;
  } catch (error) {
    stdout = error?.stdout ?? '';
    stderr = error?.stderr ?? '';
    spawnError = redact(error?.code ?? error?.message ?? 'command failed');
    timedOut = error?.code === 'ETIMEDOUT' || error?.killed === true;
    exitCode = Number.isInteger(error?.exitCode)
      ? error.exitCode
      : Number.isInteger(error?.code)
        ? error.code
        : timedOut ? 124 : error?.code === 'ENOENT' ? 127 : 1;
  }
  const endedAt = new Date().toISOString();
  const logName = `${String(receipt.commands.length + 1).padStart(2, '0')}-${label}.log`;
  const logPath = join(logDir, logName);
  const body = [
    `command: ${commandString(executable, args)}`,
    `cwd: ${cwd}`,
    `started_at_utc: ${startedAt}`,
    `ended_at_utc: ${endedAt}`,
    `exit_code: ${exitCode}`,
    `timeout_ms: ${receipt.deadline_ms ? Math.max(0, Math.min(MAX_RUN_MS, receipt.deadline_ms - Date.parse(startedAt))) : MAX_RUN_MS}`,
    `timed_out: ${timedOut}`,
    ...(spawnError ? [`spawn_error: ${spawnError}`] : []),
    '', '--- stdout ---', redact(stdout), '', '--- stderr ---', redact(stderr), '',
  ].join('\n');
  await writeFile(logPath, body, { flag: 'wx', mode: 0o600 });
  const commandRecord = {
    label, executable, args, command: commandString(executable, args),
    cwd: safePath(receipt.source.path, cwd), started_at_utc: startedAt,
    ended_at_utc: endedAt, exit_code: exitCode, log_path: logPath,
    timed_out: timedOut,
    log_sha256: await sha256(logPath), ...(spawnError ? { spawn_error: spawnError } : {}),
  };
  receipt.commands.push(commandRecord);
  await writeReceipt(receipt);
  return { ...commandRecord, stdout: String(stdout), stderr: String(stderr) };
}

async function writeReceipt(receipt) {
  await writeFile(receipt.receipt_path, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
}

function assertAdmission(admission, { repository, pin, sessionId, environmentId, environmentBinding }) {
  assert(admission && admission.schema_version === RUNNER_VERSION, 'admission schema_version must be 1');
  assert(admission.allowed === true, 'admission.allowed must be true');
  assert(admission.scope === RUNNER_SCOPE, `admission.scope must be ${RUNNER_SCOPE}`);
  assert(admission.repository === repository, 'admission repository mismatch');
  assert(admission.commit === pin, 'admission commit mismatch');
  assert(admission.task_id === 't_idem_2bde337b', 'admission task_id mismatch');
  assert(admission.host_binding_verified === true, 'exact host binding is not admitted');
  assert(admission.task_approval_verified === true, 'task mutation approval is not admitted');
  assert(admission.source_acquisition_approved === true, 'source acquisition route is not admitted');
  assert(admission.dependency_install_route_approved === true, 'frozen dependency install route is not admitted');
  assert(admission.synthetic_tests_only === true, 'admission must constrain execution to synthetic tests');
  assert(admission.no_live_provider_calls === true, 'admission must prohibit live provider calls');
  assert(typeof sessionId === 'string' && sessionId.trim().length > 0, 'current session ID is required');
  assert(admission.host && admission.host.session_id === sessionId, 'admission session binding mismatch');
  if (typeof environmentId === 'string' && environmentId.trim().length > 0) {
    assert(admission.host.environment_id === environmentId, 'admission environment binding mismatch');
  } else {
    assert(typeof environmentBinding === 'string' && environmentBinding.trim().length > 0,
      'current environment ID or explicitly declared local binding is required');
    assert(admission.host.environment_id == null && admission.host.environment_binding === environmentBinding,
      'admission local environment binding mismatch');
  }
  assert(typeof admission.expires_at_utc === 'string' && Date.parse(admission.expires_at_utc) > Date.now(), 'admission is missing or expired');
}

async function git(execute, receipt, cwd, logDir, label, args) {
  const result = await runOne(execute, receipt, { executable: 'git', args, cwd, label, env: safeEnv(), logDir });
  assert(result.exit_code === 0, `git ${args.join(' ')} failed with exit ${result.exit_code}`);
  return result.stdout.trim();
}

function isExpectedRemote(remote) {
  let hostname;
  let pathname;
  let username = '';
  let password = '';
  const ssh = /^git@([^:]+):(.+)$/.exec(remote);
  if (ssh) {
    [, hostname, pathname] = ssh;
  } else {
    let parsed;
    try { parsed = new URL(remote); } catch { return false; }
    if (!['https:', 'ssh:'].includes(parsed.protocol)) return false;
    hostname = parsed.hostname.toLowerCase();
    pathname = parsed.pathname.replace(/^\//, '');
    username = parsed.username;
    password = parsed.password;
  }
  return !username && !password && ALLOWED_REMOTE_HOSTS.has(hostname.toLowerCase()) &&
    /^InnerScopeHearing\/otchealth-companion(?:\.git)?$/.test(pathname);
}

async function validateSource(execute, receipt, repo, pin, logDir) {
  const path = await realpath(repo);
  const root = await git(execute, receipt, path, logDir, 'repo-root', ['rev-parse', '--show-toplevel']);
  assert(resolve(root) === path, 'repo must be the Git worktree root');
  const actualPin = await git(execute, receipt, path, logDir, 'source-sha', ['rev-parse', 'HEAD']);
  assert(actualPin === pin, `source SHA mismatch: expected ${pin}, got ${actualPin}`);
  const remote = await git(execute, receipt, path, logDir, 'origin-check', ['remote', 'get-url', 'origin']);
  assert(isExpectedRemote(remote), 'origin is not the expected Companion repository');
  const before = await git(execute, receipt, path, logDir, 'prestate', ['status', '--porcelain', '--untracked-files=all']);
  assert(before === '', 'source prestate must have no tracked or visible untracked changes');
  const manifestPath = join(path, 'package.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  assert(manifest.name === 'otchealth-companion', 'root package name mismatch');
  assert(manifest.packageManager === EXPECTED_PACKAGE_MANAGER, `packageManager must equal ${EXPECTED_PACKAGE_MANAGER}`);
  assert(typeof manifest.engines?.node === 'string' && /(?:^|\s|\^)\s*>=?\s*22(?:\s|$)/.test(manifest.engines.node), 'manifest must require Node >=22');
  const lock = await sha256(join(path, 'pnpm-lock.yaml'));
  for (const testPath of [
    'apps/mobile/src/boot/ErrorBoundary.test.tsx',
    'apps/mobile/src/pages/Settings.test.tsx',
  ]) {
    await readFile(join(path, testPath));
  }
  receipt.source = { repository: DEFAULT_REPOSITORY, path, sha: actualPin, package_manager: manifest.packageManager, node_engine: manifest.engines.node, lockfile_sha256_before: lock, prestate: 'clean' };
  await writeReceipt(receipt);
  return { path, before, lock };
}

export async function pnpmInvocation(admission, {
  platform = process.platform,
  nodePath = process.execPath,
} = {}) {
  if (platform !== 'win32') return { executable: 'pnpm', prefixArgs: [] };
  const binding = admission?.toolchain;
  assert(binding && typeof binding === 'object', 'Windows admission requires an exact toolchain binding');
  for (const key of ['node_path', 'pnpm_package_root', 'pnpm_cli_path']) {
    assert(typeof binding[key] === 'string' && isAbsolute(binding[key]), 'admitted ' + key + ' must be absolute');
  }
  assert(typeof nodePath === 'string' && isAbsolute(nodePath), 'running Node path must be absolute');
  assert(typeof binding.pnpm_cli_sha256 === 'string' && /^[0-9a-f]{64}$/.test(binding.pnpm_cli_sha256), 'admitted pnpm CLI SHA-256 is invalid');
  const [admittedNode, runningNode, packageRoot, cli] = await Promise.all([
    realpath(binding.node_path), realpath(nodePath),
    realpath(binding.pnpm_package_root), realpath(binding.pnpm_cli_path),
  ]);
  const samePath = (left, right) => left.toLowerCase() === right.toLowerCase();
  assert(samePath(admittedNode, runningNode), 'running Node does not match the admitted Node path');
  assert(inside(packageRoot, cli) && !samePath(packageRoot, cli), 'pnpm CLI must be inside its admitted package root');
  const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
  assert(manifest.name === 'pnpm' && manifest.version === EXPECTED_PACKAGE_MANAGER.slice('pnpm@'.length),
    'pnpm package must be ' + EXPECTED_PACKAGE_MANAGER);
  assert(manifest.bin?.pnpm === 'bin/pnpm.cjs', 'pnpm package must declare bin/pnpm.cjs');
  const declaredCli = await realpath(resolve(packageRoot, manifest.bin.pnpm));
  assert(samePath(declaredCli, cli), 'admitted pnpm CLI does not match package.bin.pnpm');
  assert(await sha256(cli) === binding.pnpm_cli_sha256, 'admitted pnpm CLI SHA-256 mismatch');
  return { executable: runningNode, prefixArgs: [cli] };
}

export async function runCompanionReadiness(options, deps = {}) {
  const startedAt = new Date().toISOString();
  const execute = deps.execute ?? (async (file, args, opts) => {
    try {
      return await execFileDefault(file, args, opts);
    } catch (error) {
      throw error;
    }
  });
  const env = deps.env ?? process.env;
  const repository = options.repository ?? DEFAULT_REPOSITORY;
  const workspaceRoot = resolve(deps.workspaceRoot ?? '/workspace/scratch/5dbf17436df9');
  assert(options.cleanupRoot === undefined || (typeof options.cleanupRoot === 'string' && isAbsolute(options.cleanupRoot)), 'cleanup root must be absolute');
  const cleanupRoot = await canonicalNoLinks(options.cleanupRoot ? resolve(options.cleanupRoot) : join(workspaceRoot, 'repair2', 'cleanup'));
  let state;
  let sourceValue = options.repo;
  let artifactValue = options.artifacts;
  let pin = options.pin ?? DEFAULT_PIN;
  if (options.state) {
    const statePath = await canonicalNoLinks(options.state);
    assert(inside(join(cleanupRoot, 'state'), statePath), 'state file must be under repair2/cleanup/state');
    state = JSON.parse(await readFile(statePath, 'utf8'));
    sourceValue = state.target;
    artifactValue = state.logs_dir;
    assert(parseSha(state.pin) && state.pin === pin, 'cleanup state pin does not match requested exact pin');
    assert(typeof state.run_id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(state.run_id), 'cleanup state must contain a safe run_id');
    assert(samePath(statePath, join(cleanupRoot, 'state', `${state.run_id}.json`)), 'state filename must bind the exact run_id');
  } else {
    assert(deps.allowDirectTarget === true, 'CLI requires cleanup state from eval_worktree.py prepare');
  }
  const sessionId = env.CODEX_SESSION_ID;
  const environmentId = env.CODEX_ENVIRONMENT_ID;
  const environmentBinding = env.CODEX_ENVIRONMENT_BINDING;
  const source = await canonicalNoLinks(sourceValue ?? '');
  const artifactDir = await canonicalNoLinks(artifactValue ?? '', true);
  assert(sourceValue && artifactValue, '--state cleanup state file is required');
  assert(parseSha(pin), 'pin must be a full 40-character lowercase commit SHA');
  assert(repository === DEFAULT_REPOSITORY, 'runner is scoped to the Companion repository');
  assert(state?.repository === undefined || state.repository === repository, 'cleanup state repository mismatch');
  assert(inside(join(cleanupRoot, 'worktrees'), source), 'repo must be a prepared cleanup-owned worktree');
  assert(inside(join(cleanupRoot, 'artifacts'), artifactDir), 'artifacts must be under the cleanup artifacts root');
  assert(!inside(source, artifactDir), 'artifacts must be outside the source worktree');
  if (state) {
    assert(samePath(source, join(cleanupRoot, 'worktrees', state.run_id)), 'target must bind the exact run_id');
    assert(samePath(artifactDir, join(cleanupRoot, 'artifacts', state.run_id)), 'logs must bind the exact run_id');
  }
  await mkdir(artifactDir, { recursive: true, mode: 0o700 });
  await canonicalNoLinks(artifactDir);
  const existing = await readdir(artifactDir);
  assert(existing.length === 0, 'artifact directory must be empty; refusing to overwrite prior evidence');
  const receiptPath = join(artifactDir, 'readiness-receipt.json');
  const receipt = {
    schema_version: RUNNER_VERSION,
    task_id: 't_idem_2bde337b',
    runner: 'companion-readiness',
    started_at_utc: startedAt,
    host: { os: `${os.platform()} ${os.arch()}`, hostname: os.hostname(), cwd: process.cwd(), session_id: sessionId ?? null, thread_id: env.CODEX_THREAD_ID ?? null, environment_id: environmentId ?? null, environment_binding: environmentBinding ?? null },
    source: { repository, path: source, expected_sha: pin },
    cleanup_run_id: state?.run_id ?? null,
    cleanup_root: cleanupRoot,
    commands: [],
    receipt_path: receiptPath,
    admission: { verified: false },
    result: 'blocked',
  };
  await writeReceipt(receipt);
  const admissionFile = resolve(options.admission ?? '');
  try {
    assert(options.admission, '--admission file is required; tests fail closed without explicit admission');
  } catch (error) {
    receipt.blocked_reason = redact(error.message);
    receipt.finished_at_utc = new Date().toISOString();
    await writeReceipt(receipt);
    throw error;
  }
  assert(!inside(source, admissionFile), 'admission file must be outside the source worktree');
  await canonicalNoLinks(admissionFile);
  const admission = JSON.parse(await readFile(admissionFile, 'utf8'));
  assertAdmission(admission, { repository, pin, sessionId, environmentId, environmentBinding });
  if (options.cleanupRoot) {
    assert(typeof admission.cleanup_root === 'string' && isAbsolute(admission.cleanup_root), 'explicit cleanup root must be bound in admission');
    const [admittedRoot, actualRoot] = await Promise.all([realpath(admission.cleanup_root), realpath(cleanupRoot)]);
    assert(inside(admittedRoot, actualRoot) && inside(actualRoot, admittedRoot), 'admission cleanup root mismatch');
  }
  receipt.deadline_ms = Math.min(Date.parse(startedAt) + MAX_RUN_MS, Date.parse(admission.expires_at_utc));
  assert(receipt.deadline_ms > Date.now(), 'admission/stage time budget expired');
  receipt.admission = { verified: true, file: admissionFile, expires_at_utc: admission.expires_at_utc };
  await writeReceipt(receipt);
  const platform = deps.platform ?? process.platform;
  let pnpmCommand;
  try {
    pnpmCommand = await pnpmInvocation(admission, { platform, nodePath: deps.nodePath ?? process.execPath });
  } catch (error) {
    receipt.blocked_reason = redact(error.message);
    receipt.finished_at_utc = new Date().toISOString();
    await writeReceipt(receipt);
    throw error;
  }
  receipt.toolchain = { pnpm_executable: pnpmCommand.executable, pnpm_prefix_args: pnpmCommand.prefixArgs };
  await writeReceipt(receipt);
  const checked = await validateSource(execute, receipt, source, pin, artifactDir);
  const node = await runOne(execute, receipt, { executable: platform === 'win32' ? pnpmCommand.executable : 'node', args: ['--version'], cwd: source, label: 'node-version', env: safeEnv(env), logDir: artifactDir });
  assert(node.exit_code === 0, `node --version failed with exit ${node.exit_code}`);
  const major = Number(node.stdout.trim().replace(/^v/, '').split('.')[0]);
  assert(Number.isInteger(major) && major >= 22, `Node >=22 required; got ${node.stdout.trim()}`);
  const pnpm = await runOne(execute, receipt, { executable: pnpmCommand.executable, args: [...pnpmCommand.prefixArgs, '--version'], cwd: source, label: 'pnpm-version', env: safeEnv(env), logDir: artifactDir });
  assert(pnpm.exit_code === 0, `pnpm --version failed with exit ${pnpm.exit_code}`);
  assert(pnpm.stdout.trim() === '9.0.0', `pnpm 9.0.0 required; got ${pnpm.stdout.trim()}`);
  const runEnv = safeEnv(env);
  const commands = [
    ['frozen-install', FROZEN_INSTALL_ARGS],
    ['focused-tests', FOCUSED_ARGS],
    ['mobile-suite', MOBILE_SUITE_ARGS],
  ];
  let failed = null;
  for (const [label, args] of commands) {
    const result = await runOne(execute, receipt, { executable: pnpmCommand.executable, args: [...pnpmCommand.prefixArgs, ...args], cwd: source, label, env: runEnv, logDir: artifactDir });
    if (result.exit_code !== 0) { failed = result; break; }
  }
  const poststate = await git(execute, receipt, source, artifactDir, 'poststate', ['status', '--porcelain', '--untracked-files=all']);
  const lockAfter = await sha256(join(source, 'pnpm-lock.yaml'));
  receipt.source.poststate = poststate === '' ? 'clean' : 'dirty';
  receipt.source.lockfile_sha256_after = lockAfter;
  receipt.restoration = {
    source_diffs: poststate === '' ? 'none' : 'visible changes present',
    lockfile_unchanged: lockAfter === checked.lock,
    cleanup_owner: 'repair2/cleanup eval_worktree.py',
    cleanup_action_required: true,
  };
  const restorationFailed = poststate !== '' || lockAfter !== checked.lock;
  receipt.result = restorationFailed ? 'restoration_failed' : failed ? 'tests_failed' : 'passed';
  receipt.finished_at_utc = new Date().toISOString();
  receipt.exit_code = restorationFailed ? 1 : failed?.exit_code ?? 0;
  await writeReceipt(receipt);
  assert(poststate === '', 'source worktree has visible changes after commands; preserve and review before cleanup');
  assert(lockAfter === checked.lock, 'frozen install changed pnpm-lock.yaml');
  if (failed) throw Object.assign(new Error(`${failed.label} failed with exit ${failed.exit_code}; see ${failed.log_path}`), { exitCode: failed.exit_code });
  return receipt;
}

function parseArgs(argv) {
  const values = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) throw new Error(`unexpected argument ${token}`);
    const key = token.slice(2);
    assert(i + 1 < argv.length, `missing value for --${key}`);
    values[key] = argv[++i];
  }
  for (const key of Object.keys(values)) assert(['state', 'admission', 'pin', 'cleanup-root'].includes(key), `unsupported argument --${key}`);
  return { ...values, cleanupRoot: values['cleanup-root'] };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const receipt = await runCompanionReadiness(parseArgs(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify({ result: receipt.result, exit_code: receipt.exit_code, receipt_path: receipt.receipt_path }, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${redact(error.message)}\n`);
    process.exitCode = Number.isInteger(error.exitCode) ? error.exitCode : 1;
  }
}
