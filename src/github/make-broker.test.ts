import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  executeMakeGitHubBroker,
  makeGitHubBrokerBranch,
  makeGitHubBrokerKeyHash,
  MakeGitHubBrokerPolicyError,
  MAKE_GITHUB_REPOSITORY,
  parseMakeGitHubBrokerCall,
  type MakeGitHubBrokerDependencies,
} from './make-broker.js';

const KEY = 'make-pilot-test-request-0001';
const SOURCE_SHA = 'a'.repeat(40);
const FILE_SHA = 'b'.repeat(40);
const CORRELATION_ID = 'corr-make-github-pilot-001';

function createBranchRequest(idempotencyKey = KEY, fromSha = SOURCE_SHA) {
  return {
    tool_name: 'github_create_branch',
    arguments: {
      owner: MAKE_GITHUB_REPOSITORY.owner,
      repo: MAKE_GITHUB_REPOSITORY.repo,
      branch: makeGitHubBrokerBranch(idempotencyKey),
      from_sha: fromSha,
    },
    idempotency_key: idempotencyKey,
  };
}

function makeFakeDependencies(options: {
  mainSha?: string | null;
  branches?: Record<string, string>;
  fileText?: string;
} = {}) {
  const calls = {
    branchReads: [] as string[],
    creates: [] as Array<{ branch: string; fromSha: string }>,
    fileReads: [] as Array<{ path: string; ref: string }>,
  };
  const branches = new Map<string, string>(Object.entries(options.branches ?? {}));
  if (options.mainSha !== null) branches.set('main', options.mainSha ?? SOURCE_SHA);
  const dependencies: MakeGitHubBrokerDependencies = {
    getBranchSha: async (branch) => {
      calls.branchReads.push(branch);
      return branches.get(branch) ?? null;
    },
    createBranch: async (branch, fromSha) => {
      calls.creates.push({ branch, fromSha });
      if (branches.has(branch)) throw new Error('branch already exists');
      branches.set(branch, fromSha);
      return { sha: fromSha };
    },
    getFileContents: async (path, ref) => {
      calls.fileReads.push({ path, ref });
      return { sha: FILE_SHA, text: options.fileText ?? '{"name":"otchealth-mcp-server"}' };
    },
  };
  return { calls, branches, dependencies };
}

function isPolicyError(code: string) {
  return (error: unknown) => error instanceof MakeGitHubBrokerPolicyError && error.code === code;
}

test('creates one deterministic claude pilot branch and returns idempotency and correlation receipts', async () => {
  const fake = makeFakeDependencies();
  const request = createBranchRequest();

  const result = await executeMakeGitHubBroker(request, CORRELATION_ID, fake.dependencies, false);

  assert.equal(result.outcome, 'created');
  assert.equal(result.executed, true);
  assert.equal(result.dry_run, false);
  assert.equal(result.branch, makeGitHubBrokerBranch(KEY));
  assert.equal(result.sha, SOURCE_SHA);
  assert.equal(result.idempotency_key_sha256, makeGitHubBrokerKeyHash(KEY));
  assert.match(result.request_sha256, /^[a-f0-9]{64}$/);
  assert.equal(result.correlation_id, CORRELATION_ID);
  assert.deepEqual(fake.calls.branchReads, [makeGitHubBrokerBranch(KEY), 'main']);
  assert.deepEqual(fake.calls.creates, [{ branch: makeGitHubBrokerBranch(KEY), fromSha: SOURCE_SHA }]);
});

test('replays the same key and payload without a second GitHub write', async () => {
  const branch = makeGitHubBrokerBranch(KEY);
  const fake = makeFakeDependencies({ branches: { [branch]: SOURCE_SHA } });

  const result = await executeMakeGitHubBroker(createBranchRequest(), CORRELATION_ID, fake.dependencies, false);

  assert.equal(result.outcome, 'replayed');
  assert.equal(result.sha, SOURCE_SHA);
  assert.equal(fake.calls.creates.length, 0);
  assert.deepEqual(fake.calls.branchReads, [branch]);
});

test('reconciles an uncertain or duplicate create acknowledgement by exact branch readback', async () => {
  const branch = makeGitHubBrokerBranch(KEY);
  const fake = makeFakeDependencies();
  let reads = 0;
  fake.dependencies.getBranchSha = async (name) => {
    fake.calls.branchReads.push(name);
    reads += 1;
    if (name === 'main') return SOURCE_SHA;
    return reads >= 3 ? SOURCE_SHA : null;
  };
  fake.dependencies.createBranch = async (name, fromSha) => {
    fake.calls.creates.push({ branch: name, fromSha });
    throw new Error('unknown create acknowledgement');
  };

  const result = await executeMakeGitHubBroker(createBranchRequest(), CORRELATION_ID, fake.dependencies, false);

  assert.equal(result.outcome, 'replayed');
  assert.equal(fake.calls.creates.length, 1);
  assert.deepEqual(fake.calls.branchReads, [branch, 'main', branch]);
});

test('rejects unknown tools, out-of-scope resources, bad refs and extra nested fields before any GitHub call', async () => {
  const branch = makeGitHubBrokerBranch(KEY);
  const validCreate = createBranchRequest();
  const invalidRequests = [
    { ...validCreate, tool_name: 'github_dispatch_workflow' },
    { ...validCreate, arguments: { ...validCreate.arguments, owner: 'OtherOrg' } },
    { ...validCreate, arguments: { ...validCreate.arguments, repo: 'other-repo' } },
    { ...validCreate, arguments: { ...validCreate.arguments, branch: 'main' } },
    { ...validCreate, arguments: { ...validCreate.arguments, branch: `${branch}-other` } },
    { ...validCreate, arguments: { ...validCreate.arguments, unlisted: true } },
    { ...validCreate, idempotency_key: 'short' },
    {
      tool_name: 'github_get_file_contents',
      arguments: {
        owner: MAKE_GITHUB_REPOSITORY.owner,
        repo: MAKE_GITHUB_REPOSITORY.repo,
        path: '.env',
        ref: branch,
      },
      idempotency_key: KEY,
    },
    {
      tool_name: 'github_get_file_contents',
      arguments: {
        owner: MAKE_GITHUB_REPOSITORY.owner,
        repo: MAKE_GITHUB_REPOSITORY.repo,
        path: 'package.json',
        ref: 'main',
      },
      idempotency_key: KEY,
    },
  ];

  for (const request of invalidRequests) {
    const fake = makeFakeDependencies();
    await assert.rejects(
      executeMakeGitHubBroker(request, CORRELATION_ID, fake.dependencies, false),
      MakeGitHubBrokerPolicyError,
    );
    assert.deepEqual(fake.calls.branchReads, [], 'invalid request must be rejected before any GitHub read');
    assert.deepEqual(fake.calls.creates, [], 'invalid request must be rejected before any GitHub write');
    assert.deepEqual(fake.calls.fileReads, [], 'invalid request must be rejected before any GitHub read');
  }
});

test('rejects a stale source commit before the branch write', async () => {
  const fake = makeFakeDependencies({ mainSha: FILE_SHA });

  await assert.rejects(
    executeMakeGitHubBroker(createBranchRequest(KEY, SOURCE_SHA), CORRELATION_ID, fake.dependencies, false),
    isPolicyError('base_ref_mismatch'),
  );

  assert.equal(fake.calls.creates.length, 0);
  assert.deepEqual(fake.calls.branchReads, [makeGitHubBrokerBranch(KEY), 'main']);
});

test('rejects an existing pilot ref at a different commit without writing', async () => {
  const branch = makeGitHubBrokerBranch(KEY);
  const fake = makeFakeDependencies({ branches: { [branch]: FILE_SHA } });

  await assert.rejects(
    executeMakeGitHubBroker(createBranchRequest(), CORRELATION_ID, fake.dependencies, false),
    isPolicyError('idempotency_conflict'),
  );

  assert.equal(fake.calls.creates.length, 0);
  assert.deepEqual(fake.calls.branchReads, [branch]);
});

test('dry run returns the planned branch receipt without calling GitHub', async () => {
  const fake = makeFakeDependencies();

  const result = await executeMakeGitHubBroker(createBranchRequest(), CORRELATION_ID, fake.dependencies, true);

  assert.equal(result.outcome, 'planned');
  assert.equal(result.executed, false);
  assert.equal(result.dry_run, true);
  assert.equal(result.branch, makeGitHubBrokerBranch(KEY));
  assert.deepEqual(fake.calls.branchReads, []);
  assert.deepEqual(fake.calls.creates, []);
});

test('reads only package.json from the same key-derived pilot ref and returns a receipt', async () => {
  const branch = makeGitHubBrokerBranch(KEY);
  const fake = makeFakeDependencies({ branches: { [branch]: SOURCE_SHA } });
  const request = {
    tool_name: 'github_get_file_contents',
    arguments: {
      owner: MAKE_GITHUB_REPOSITORY.owner,
      repo: MAKE_GITHUB_REPOSITORY.repo,
      path: 'package.json',
      ref: branch,
    },
    idempotency_key: KEY,
  };

  const result = await executeMakeGitHubBroker(request, CORRELATION_ID, fake.dependencies, false);

  assert.equal(result.outcome, 'read');
  assert.equal(result.executed, true);
  assert.equal(result.text, '{"name":"otchealth-mcp-server"}');
  assert.equal(result.idempotency_key_sha256, makeGitHubBrokerKeyHash(KEY));
  assert.equal(result.correlation_id, CORRELATION_ID);
  assert.deepEqual(fake.calls.fileReads, [{ path: 'package.json', ref: branch }]);
});

test('parser fails closed for a tool name that is not in the pilot list', () => {
  assert.throws(
    () => parseMakeGitHubBrokerCall({
      ...createBranchRequest(),
      tool_name: 'github_merge_pull_request',
    }),
    isPolicyError('tool_not_allowed'),
  );
});
