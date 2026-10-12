import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'pkcs1', format: 'pem' } });
Object.assign(process.env, {
  CIO_SITE_ID: 'synthetic-site', CIO_TRACK_KEY: 'synthetic-track', CIO_APP_API_BEARER: 'synthetic-bearer',
  PERPLEXITY_CONNECTOR_TOKEN: `synthetic-${'a'.repeat(40)}`, ADMIN_REVOKE_TOKEN: `synthetic-${'b'.repeat(40)}`,
  N8N_WEBHOOK_SECRET: `synthetic-${'c'.repeat(40)}`, GITHUB_APP_ID: '15368', GITHUB_APP_INSTALLATION_ID: '789', GITHUB_APP_PRIVATE_KEY: privateKey,
  ENABLE_WRITE_TOOLS: 'true', READ_ONLY_MODE: 'false', SHIELD_MODE: 'off', COLD_START_MODE: 'off', TOOL_CATALOG_CURATION_MODE: 'off',
});

const { mergePullRequest } = await import('./api-client.js');
const { registerGitHubMergePullRequest } = await import('../tools/github/merge-pull-request.js');
const { requestContext } = await import('../server/request-context.js');
const owner = 'InnerScopeHearing';
const repo = 'aware-aural-rehab';
const head = '25ee4f3f5f379c1822dec234549f4559778cf8a4';
const head166 = '80441e7fbac340ece059342d78aba2ce5ab57f27';
const required = ['syntax', 'unit', 'a11y', 'gitleaks secret scan', 'Required web release gates', 'trufflehog verified-secret scan'];

function response(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}

function fixture(options: { number?: number; reviewedHead?: string; draft?: boolean; head?: string; failed?: string; includeChecks?: boolean; readyMismatch?: boolean; postReadyHead?: string; wrongApp?: boolean; duplicateCheck?: boolean; closed?: boolean; wrongBase?: boolean; wrongNode?: boolean; emptyNode?: boolean; wrongGraphQLNode?: boolean; wrongRepository?: boolean; wrongNumber?: boolean; graphqlFailure?: boolean; protectionMissing?: boolean; protectionWrongApp?: boolean; protectionExtra?: boolean; malformedReadyDraft?: boolean; wrongCheckHead?: boolean; totalCount?: number } = {}) {
  const events: string[] = [];
  const urls: string[] = [];
  const mergeBodies: unknown[] = [];
  const graphqlBodies: any[] = [];
  let prReads = 0;
  const prNumber = options.number ?? 165;
  const reviewedHead = options.reviewedHead ?? head;
  const fetchStub = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    urls.push(url);
    if (url.includes('/app/installations/') && url.endsWith('/access_tokens')) return response({ token: 'ghs_fake', expires_at: new Date(Date.now() + 3600_000).toISOString() }, 201);
    if (url.includes(`/pulls/${prNumber}`) && !url.endsWith('/merge') && init?.method === 'GET') {
      events.push('pr'); prReads++;
      return response({ number: options.wrongNumber ? prNumber + 1 : prNumber, state: options.closed ? 'closed' : 'open', merged: false, draft: prReads === 1 ? (options.draft ?? true) : (options.malformedReadyDraft ? null : (options.readyMismatch ?? false)), base: { ref: options.wrongBase ? 'release' : 'main', repo: { full_name: options.wrongRepository ? 'other/repo' : `${owner}/${repo}` } }, head: { sha: prReads > 1 ? (options.postReadyHead ?? options.head ?? reviewedHead) : (options.head ?? reviewedHead) }, node_id: options.emptyNode ? '' : (options.wrongNode ? 'OTHER_PR' : 'PR_node') });
    }
    if (url.includes('/check-runs')) {
      events.push('checks');
      const checks = (options.includeChecks === false ? required.slice(0, 5) : required).map((name) => ({ name, head_sha: options.wrongCheckHead ? 'other-sha' : reviewedHead, app: { id: options.wrongApp ? 1 : 15368 }, status: 'completed', conclusion: name === options.failed ? 'failure' : 'success' }));
      if (options.duplicateCheck) checks.push({ ...checks[0]!, conclusion: 'failure' });
      return response({ total_count: options.totalCount ?? checks.length, check_runs: checks });
    }
    if (url.endsWith('/branches/main/protection')) {
      events.push('protection');
      const contexts = options.protectionMissing ? required.slice(1) : [...required, ...(options.protectionExtra ? ['unexpected check'] : [])];
      return response({ required_status_checks: { strict: false, contexts, checks: (options.protectionWrongApp ? required.map((context) => ({ context, app_id: 9 })) : contexts.map((context) => ({ context, app_id: 15368 }))) } });
    }
    if (url.endsWith('/graphql')) {
      events.push('ready');
      graphqlBodies.push(JSON.parse(String(init?.body)));
      return options.graphqlFailure ? response({ errors: [{ message: 'denied' }] }) : response({ data: { markPullRequestReadyForReview: { pullRequest: { id: options.wrongGraphQLNode ? 'OTHER_PR' : 'PR_node', isDraft: false } } } });
    }
    if (url.endsWith(`/pulls/${prNumber}/merge`) && init?.method === 'PUT') {
      events.push('merge');
      mergeBodies.push(JSON.parse(String(init?.body)));
      return events.includes('ready')
        ? response({ merged: true, sha: 'merge-sha', message: 'merged' })
        : response({ message: 'Draft pull request cannot be merged' }, 405);
    }
    throw new Error(`unexpected request ${init?.method} ${url}`);
  }) as typeof fetch;
  return { events, urls, fetchStub, mergeBodies, graphqlBodies };
}

async function withFetch<T>(stub: typeof fetch, run: () => Promise<T>): Promise<T> {
  const old = globalThis.fetch; globalThis.fetch = stub;
  try { return await run(); } finally { globalThis.fetch = old; }
}

test('reviewed AWARE draft promotion is CTO-opt-in, fully gated, reread, then SHA-pinned merge', async () => {
  const f = fixture();
  await withFetch(f.fetchStub, async () => {
    const result = await mergePullRequest(owner, repo, 165, 'squash', undefined, true);
    assert.equal(result.merged, true);
  });
  assert.deepEqual(f.events, ['pr', 'checks', 'protection', 'ready', 'pr', 'merge']);
  assert.deepEqual(f.mergeBodies, [{ merge_method: 'squash', sha: head }]);
  assert.equal(f.graphqlBodies[0]?.variables?.pullRequestId, 'PR_node');
  const checkUrl = f.urls.find((url) => url.includes('/check-runs'));
  assert.ok(checkUrl);
  assert.ok(checkUrl!.includes(head));
});

test('second reviewed AWARE PR is pinned to its own reviewed head', async () => {
  const f = fixture({ number: 166, reviewedHead: head166 });
  await withFetch(f.fetchStub, async () => { const result = await mergePullRequest(owner, repo, 166, 'squash', undefined, true); assert.equal(result.merged, true); });
  assert.deepEqual(f.mergeBodies, [{ merge_method: 'squash', sha: head166 }]);
});

test('reviewed AWARE draft is not promoted without explicit CTO opt-in', async () => {
  const f = fixture();
  await withFetch(f.fetchStub, async () => {
    await assert.rejects(() => mergePullRequest(owner, repo, 165), (e: any) => e?.status === 405);
  });
  assert.deepEqual(f.events, ['merge']);
});

test('non-approved repository keeps the existing generic merge attempt', async () => {
  const f = fixture();
  await withFetch(f.fetchStub, async () => {
    await assert.rejects(() => mergePullRequest(owner, 'unrelated-repo', 165), (e: any) => e?.status === 405);
  });
  assert.deepEqual(f.events, ['merge']);
});

test('registered tool passes CTO identity only, and dry-run remains network-free', async () => {
  type Handler = (args: any) => Promise<any>;
  let handler: Handler | undefined;
  const server = { registerTool(_name: string, _config: unknown, candidate: Handler) { handler = candidate; return { remove() {} }; } } as any;
  registerGitHubMergePullRequest(server, () => 'synthetic-caller');
  assert.ok(handler);
  const dry = fixture();
  await withFetch(dry.fetchStub, async () => {
    await requestContext.run({ callerHash: 'synthetic-caller', correlationId: 'synthetic-dry-run', callerAgent: 'cto' } as any, () => handler!({ owner, repo, number: 165, method: 'squash', dry_run: true }));
  });
  assert.deepEqual(dry.events, []);

  const cto = fixture();
  await withFetch(cto.fetchStub, async () => {
    await requestContext.run({ callerHash: 'synthetic-caller', correlationId: 'synthetic-cto', callerAgent: 'cto' } as any, () => handler!({ owner, repo, number: 165, method: 'squash', dry_run: false }));
  });
  assert.ok(cto.events.includes('ready'));

  const nonCto = fixture();
  await withFetch(nonCto.fetchStub, async () => {
    const result = await requestContext.run({ callerHash: 'synthetic-caller', correlationId: 'synthetic-noncto', callerAgent: 'inner_scope_hearing' } as any, () => handler!({ owner, repo, number: 165, method: 'squash', dry_run: false }));
    assert.match(JSON.stringify(result), /forbidden_role|not authorized/i);
  });
  assert.deepEqual(nonCto.events, []);
});

for (const [label, options] of [
  ['wrong reviewed head', { head: 'stale-sha' }],
  ['failed required check', { failed: 'a11y' }],
  ['missing required check', { includeChecks: false }],
  ['check from the wrong App', { wrongApp: true }],
  ['ambiguous duplicate required check', { duplicateCheck: true }],
  ['draft state changed or mismatched after promotion', { readyMismatch: true }],
  ['head changed after readiness promotion', { postReadyHead: 'different-sha' }],
  ['closed pull request', { closed: true }],
  ['wrong base branch', { wrongBase: true }],
  ['wrong PR node identity', { wrongNode: true }],
  ['empty PR node identity', { emptyNode: true }],
  ['wrong GraphQL PR identity', { wrongGraphQLNode: true }],
  ['wrong returned PR number', { wrongNumber: true }],
  ['wrong returned repository identity', { wrongRepository: true }],
  ['wrong check head SHA', { wrongCheckHead: true }],
  ['incomplete paginated checks', { totalCount: 7 }],
  ['missing protected context', { protectionMissing: true }],
  ['wrong protected-check App', { protectionWrongApp: true }],
  ['extra protected context', { protectionExtra: true }],
  ['malformed ready draft state', { malformedReadyDraft: true }],
  ['GraphQL readiness failure', { graphqlFailure: true }],
] as const) {
  test(`reviewed merge fails closed on ${label}`, async () => {
    const f = fixture(options);
    await withFetch(f.fetchStub, async () => {
      await assert.rejects(() => mergePullRequest(owner, repo, 165, 'squash', undefined, true));
    });
    assert.equal(f.events.includes('merge'), false);
  });
}

