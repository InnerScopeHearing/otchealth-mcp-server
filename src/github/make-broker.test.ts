import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  executeMakeGitHubBroker,
  makeGitHubBrokerBranch,
  makeGitHubBrokerKeyHash,
  MakeGitHubBrokerPolicyError,
  MAKE_GITHUB_REPOSITORY,
  parseMakeGitHubBrokerCall,
  redactMakeGitHubBrokerInputForLog,
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
  assert.equal(result.from_sha, SOURCE_SHA);
  assert.equal(result.idempotency_key_sha256, makeGitHubBrokerKeyHash(KEY));
  assert.match(result.request_sha256, /^[a-f0-9]{64}$/);
  assert.equal(result.correlation_id, CORRELATION_ID);
  assert.deepEqual(fake.calls.branchReads, [makeGitHubBrokerBranch(KEY), 'main', makeGitHubBrokerBranch(KEY)]);
  assert.deepEqual(fake.calls.creates, [{ branch: makeGitHubBrokerBranch(KEY), fromSha: SOURCE_SHA }]);
});

test('replays the same key and payload without a second GitHub write', async () => {
  const branch = makeGitHubBrokerBranch(KEY);
  const fake = makeFakeDependencies({ branches: { [branch]: SOURCE_SHA } });

  const result = await executeMakeGitHubBroker(createBranchRequest(), CORRELATION_ID, fake.dependencies, false);

  assert.equal(result.outcome, 'replayed');
  assert.equal(result.sha, SOURCE_SHA);
  assert.equal(result.from_sha, SOURCE_SHA);
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
  const validCreate = createBranchRequest();
  const invalidRequests = [
    { ...validCreate, tool_name: 'github_dispatch_workflow' },
    { ...validCreate, arguments: { ...validCreate.arguments, owner: 'OtherOrg' } },
    { ...validCreate, arguments: { ...validCreate.arguments, repo: 'other-repo' } },
    { ...validCreate, arguments: { ...validCreate.arguments, branch: 'main' } },
    { ...validCreate, arguments: { ...validCreate.arguments, from_sha: 'not-a-sha' } },
    { ...validCreate, arguments: { owner: MAKE_GITHUB_REPOSITORY.owner, repo: MAKE_GITHUB_REPOSITORY.repo } },
    { ...validCreate, arguments: { ...validCreate.arguments, unlisted: true } },
    { ...validCreate, extra: true },
    { ...validCreate, idempotency_key: 'short' },
    {
      tool_name: 'github_get_file_contents',
      arguments: {
        owner: MAKE_GITHUB_REPOSITORY.owner,
        repo: MAKE_GITHUB_REPOSITORY.repo,
        path: '.env',
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
    {
      tool_name: 'github_get_main_sha',
      arguments: { ref: 'develop' },
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

test('creates only from a caller SHA that matches the independently verified current main head', async () => {
  const fake = makeFakeDependencies({ mainSha: FILE_SHA });

  const result = await executeMakeGitHubBroker(createBranchRequest(KEY, FILE_SHA), CORRELATION_ID, fake.dependencies, false);

  assert.equal(result.outcome, 'created');
  assert.equal(result.sha, FILE_SHA);
  assert.equal(result.from_sha, FILE_SHA);
  assert.deepEqual(fake.calls.branchReads, [makeGitHubBrokerBranch(KEY), 'main', makeGitHubBrokerBranch(KEY)]);
  assert.deepEqual(fake.calls.creates, [{ branch: makeGitHubBrokerBranch(KEY), fromSha: FILE_SHA }]);
});

test('rejects a stale or mismatching caller source SHA before branch creation', async () => {
  const fake = makeFakeDependencies({ mainSha: FILE_SHA });

  await assert.rejects(
    executeMakeGitHubBroker(createBranchRequest(KEY, SOURCE_SHA), CORRELATION_ID, fake.dependencies, false),
    isPolicyError('main_ref_mismatch'),
  );
  assert.equal(fake.calls.creates.length, 0);
  assert.deepEqual(fake.calls.branchReads, [makeGitHubBrokerBranch(KEY), 'main']);
});

test('branch creation rechecks main after Make reads its SHA and rejects that SHA if main has moved', async () => {
  const fake = makeFakeDependencies({ mainSha: SOURCE_SHA });
  const mainRequest = {
    tool_name: 'github_get_main_sha',
    arguments: {},
    idempotency_key: KEY,
  };

  const discovery = await executeMakeGitHubBroker(mainRequest, CORRELATION_ID, fake.dependencies, false);
  assert.equal(discovery.sha, SOURCE_SHA);

  fake.branches.set('main', FILE_SHA);
  await assert.rejects(
    executeMakeGitHubBroker(createBranchRequest(KEY, discovery.sha!), CORRELATION_ID, fake.dependencies, false),
    isPolicyError('main_ref_mismatch'),
  );
  assert.equal(fake.calls.creates.length, 0);
  assert.deepEqual(fake.calls.branchReads, ['main', makeGitHubBrokerBranch(KEY), 'main']);
});

test('rejects a missing or malformed main SHA before creating a branch', async () => {
  for (const [mainSha, errorCode] of [[null, 'main_ref_missing'], ['not-a-sha', 'main_ref_invalid']] as const) {
    const fake = makeFakeDependencies({ mainSha });
    await assert.rejects(
      executeMakeGitHubBroker(createBranchRequest(), CORRELATION_ID, fake.dependencies, false),
      isPolicyError(errorCode),
    );
    assert.equal(fake.calls.creates.length, 0);
    assert.deepEqual(fake.calls.branchReads, [makeGitHubBrokerBranch(KEY), 'main']);
  }
});

test('rejects an existing key-derived branch whose SHA differs from the request source', async () => {
  const branch = makeGitHubBrokerBranch(KEY);
  const fake = makeFakeDependencies({ branches: { [branch]: FILE_SHA } });

  await assert.rejects(
    executeMakeGitHubBroker(createBranchRequest(), CORRELATION_ID, fake.dependencies, false),
    isPolicyError('idempotency_conflict'),
  );
  assert.equal(fake.calls.creates.length, 0);
  assert.deepEqual(fake.calls.branchReads, [branch]);
});

test('does not report a created receipt when independent branch readback is missing or mismatched', async () => {
  for (const [readbackSha, errorCode] of [[null, 'branch_readback_missing'], [FILE_SHA, 'branch_readback_mismatch']] as const) {
    const fake = makeFakeDependencies();
    let branchReadCount = 0;
    fake.dependencies.getBranchSha = async (name) => {
      fake.calls.branchReads.push(name);
      if (name === 'main') return SOURCE_SHA;
      branchReadCount += 1;
      return branchReadCount === 1 ? null : readbackSha;
    };

    await assert.rejects(
      executeMakeGitHubBroker(createBranchRequest(), CORRELATION_ID, fake.dependencies, false),
      isPolicyError(errorCode),
    );
    assert.equal(fake.calls.creates.length, 1);
    assert.deepEqual(fake.calls.branchReads, [makeGitHubBrokerBranch(KEY), 'main', makeGitHubBrokerBranch(KEY)]);
  }
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
    },
    idempotency_key: KEY,
  };

  const result = await executeMakeGitHubBroker(request, CORRELATION_ID, fake.dependencies, false);

  assert.equal(result.outcome, 'read');
  assert.equal(result.executed, true);
  assert.equal(result.text, '{"name":"otchealth-mcp-server"}');
  assert.equal(result.ref, branch);
  assert.equal(result.idempotency_key_sha256, makeGitHubBrokerKeyHash(KEY));
  assert.equal(result.correlation_id, CORRELATION_ID);
  assert.deepEqual(fake.calls.fileReads, [{ path: 'package.json', ref: branch }]);
});

test('reads only the fixed main ref and returns a compact SHA receipt', async () => {
  const fake = makeFakeDependencies({ mainSha: FILE_SHA });
  const request = {
    tool_name: 'github_get_main_sha',
    arguments: {},
    idempotency_key: KEY,
  };

  const result = await executeMakeGitHubBroker(request, CORRELATION_ID, fake.dependencies, false);

  assert.equal(result.outcome, 'read');
  assert.equal(result.executed, true);
  assert.equal(result.dry_run, false);
  assert.equal(result.tool_name, 'github_get_main_sha');
  assert.equal(result.ref, 'main');
  assert.equal(result.sha, FILE_SHA);
  assert.equal(result.text, undefined);
  assert.equal(result.path, undefined);
  assert.deepEqual(fake.calls.branchReads, ['main']);
  assert.deepEqual(fake.calls.fileReads, []);
  assert.deepEqual(fake.calls.creates, []);
});

test('fixed main SHA read fails closed when main is missing or malformed', async () => {
  for (const [mainSha, errorCode] of [[null, 'main_ref_missing'], ['not-a-sha', 'main_ref_invalid']] as const) {
    const fake = makeFakeDependencies({ mainSha });
    await assert.rejects(
      executeMakeGitHubBroker({
        tool_name: 'github_get_main_sha',
        arguments: {},
        idempotency_key: KEY,
      }, CORRELATION_ID, fake.dependencies, false),
      isPolicyError(errorCode),
    );
    assert.deepEqual(fake.calls.branchReads, ['main']);
    assert.deepEqual(fake.calls.fileReads, []);
    assert.deepEqual(fake.calls.creates, []);
  }
});

test('dry-run file read returns a plan without making any GitHub request', async () => {
  const fake = makeFakeDependencies();
  const request = {
    tool_name: 'github_get_file_contents',
    arguments: {
      owner: MAKE_GITHUB_REPOSITORY.owner,
      repo: MAKE_GITHUB_REPOSITORY.repo,
      path: 'package.json',
    },
    idempotency_key: KEY,
  };

  const result = await executeMakeGitHubBroker(request, CORRELATION_ID, fake.dependencies, true);

  assert.equal(result.outcome, 'planned');
  assert.equal(result.executed, false);
  assert.equal(result.dry_run, true);
  assert.equal(result.tool_name, 'github_get_file_contents');
  assert.equal(result.path, 'package.json');
  assert.equal(result.ref, makeGitHubBrokerBranch(KEY));
  assert.equal(result.sha, undefined);
  assert.equal(result.text, undefined);
  assert.deepEqual(fake.calls.fileReads, []);
  assert.deepEqual(fake.calls.branchReads, []);
  assert.deepEqual(fake.calls.creates, []);
});

test('dry-run main SHA read returns a plan without making any GitHub request', async () => {
  const fake = makeFakeDependencies();
  const result = await executeMakeGitHubBroker({
    tool_name: 'github_get_main_sha',
    arguments: {},
    idempotency_key: KEY,
  }, CORRELATION_ID, fake.dependencies, true);

  assert.equal(result.outcome, 'planned');
  assert.equal(result.executed, false);
  assert.equal(result.dry_run, true);
  assert.equal(result.tool_name, 'github_get_main_sha');
  assert.equal(result.ref, 'main');
  assert.equal(result.sha, undefined);
  assert.deepEqual(fake.calls.branchReads, []);
  assert.deepEqual(fake.calls.fileReads, []);
  assert.deepEqual(fake.calls.creates, []);
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

test('log projection keeps only allowlisted field names and a one-way idempotency digest', () => {
  const sensitiveSentinel = 'PRIVATE_NESTED_VALUE_7a9f4d1b';
  const projected = redactMakeGitHubBrokerInputForLog({
    tool_name: 'github_create_branch',
    arguments: {
      owner: MAKE_GITHUB_REPOSITORY.owner,
      repo: MAKE_GITHUB_REPOSITORY.repo,
      from_sha: SOURCE_SHA,
      unexpected_nested: { access_token: sensitiveSentinel },
    },
    idempotency_key: KEY,
    unexpected_top_level: sensitiveSentinel,
  });

  assert.deepEqual(projected, {
    tool_name: 'github_create_branch',
    argument_fields: ['owner', 'repo', 'from_sha'],
    idempotency_key_sha256: makeGitHubBrokerKeyHash(KEY),
  });
  assert.equal(JSON.stringify(projected).includes(sensitiveSentinel), false);
  assert.equal(JSON.stringify(projected).includes(SOURCE_SHA), false);
  assert.equal(JSON.stringify(projected).includes(KEY), false);
});

test('log projection does not echo an unlisted tool name or its sensitive-looking arguments', () => {
  const sensitiveSentinel = 'UNLISTED_TOOL_SECRET_VALUE_98d2';
  const projected = redactMakeGitHubBrokerInputForLog({
    tool_name: `github_${sensitiveSentinel}`,
    arguments: { token: sensitiveSentinel, nested: { value: sensitiveSentinel } },
    idempotency_key: 'bad',
  });

  assert.deepEqual(projected, { tool_name: 'unlisted', argument_fields: [] });
  assert.equal(JSON.stringify(projected).includes(sensitiveSentinel), false);
});

test('main SHA log projection records no caller-controlled argument fields', () => {
  const projected = redactMakeGitHubBrokerInputForLog({
    tool_name: 'github_get_main_sha',
    arguments: { ref: 'attacker-controlled-ref', owner: 'OtherOrg' },
    idempotency_key: KEY,
  });

  assert.deepEqual(projected, {
    tool_name: 'github_get_main_sha',
    argument_fields: [],
    idempotency_key_sha256: makeGitHubBrokerKeyHash(KEY),
  });
});
