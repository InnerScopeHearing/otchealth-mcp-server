import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Regression tests for the 2026-08-18 confirmed defect: `github_list_workflow_runs` was called
// with `status: "waiting"` (looking for a run blocked on an environment-protection approval gate)
// and silently returned COMPLETED runs instead -- no error, no warning, the filter was just gone.
//
// ROOT CAUSE (see the PR description for the full file:line trail): the tool's `inputShape` never
// declared `status` at all. The MCP SDK's OWN top-level input validation
// (`McpServer.validateToolInput` -> `normalizeObjectSchema` -> a plain, NON-strict `z.object()`
// built from that exact `inputShape`) parses the incoming call arguments BEFORE our handler (or
// even registry.ts's own second `.strict()` "reject unexpected fields" layer) ever runs. Zod's
// default "strip unknown keys" behavior means any field absent from `inputShape` is silently
// dropped by the SDK at that point -- registry.ts's own strict re-check can never catch it, because
// by the time it runs the field is already gone; both layers key off the SAME shape object.
//
// So the ONLY test that actually reproduces (and would have caught) this bug is one that drives a
// REAL MCP tool call through the REAL SDK request-validation pipeline -- not a direct call to an
// internal function with the "right" signature. These tests do that: a real McpServer + Client
// connected over a real (SDK-provided) InMemoryTransport pair, exactly as a real MCP client would.
// ─────────────────────────────────────────────────────────────────────────────────────────────

// api-client.ts reads DEVELOPER_ALLOWED_REPOS via loadEnv(), which memoizes on its FIRST call in
// this process (src/config/env.ts's module-level `cached`). That means this value must be fixed
// here, before anything imports api-client.ts -- mutating process.env.DEVELOPER_ALLOWED_REPOS
// later in the file (e.g. inside a single test) has NO effect on assertRepoAllowed's view of it.
// So the whole file runs under ONE fixed, deliberately-restrictive value; tests that want to prove
// a filter/pipeline behavior unrelated to repo-scoping use callerAgent='cto' (which
// assertRepoAllowed always exempts, matching every sibling github_* read tool), and the two tests
// that specifically exercise assertRepoAllowed use 'developer' vs 'cto' against that same fixed
// allowlist instead of toggling the env var.
const RESTRICTED_TEST_REPO_ALLOWLIST = 'InnerScopeHearing/some-other-repo-not-under-test';

before(() => {
  process.env.CIO_SITE_ID ??= 'test';
  process.env.CIO_TRACK_KEY ??= 'test';
  process.env.CIO_APP_API_BEARER ??= 'test';
  process.env.PERPLEXITY_CONNECTOR_TOKEN ??= 'a'.repeat(32);
  process.env.ADMIN_REVOKE_TOKEN ??= 'b'.repeat(32);
  process.env.N8N_WEBHOOK_SECRET ??= 'c'.repeat(32);
  process.env.DEVELOPER_ALLOWED_REPOS ??= RESTRICTED_TEST_REPO_ALLOWLIST;
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
  });
  process.env.GITHUB_APP_ID ??= '123456';
  process.env.GITHUB_APP_INSTALLATION_ID ??= '789';
  process.env.GITHUB_APP_PRIVATE_KEY ??= privateKey;
});

// Same idiom as src/util/fetch-budget.test.ts: globalThis.fetch is a genuine global, not a module
// export, so a direct reassignment works even though this repo's ESM build blocks mock.method()
// from overriding another module's live named export.
async function withStubbedFetch<T>(stub: typeof fetch, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

function githubStub(capturedUrls: string[]): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/app/installations/') && url.endsWith('/access_tokens')) {
      return new Response(
        JSON.stringify({ token: 'ghs_fake', expires_at: new Date(Date.now() + 3600_000).toISOString() }),
        { status: 201, headers: { 'content-type': 'application/json' } },
      );
    }
    if (url.includes('/actions/runs')) {
      capturedUrls.push(url);
      return new Response(
        JSON.stringify({ workflow_runs: [{ id: 1, name: 'CI', status: 'completed', conclusion: 'success', head_branch: 'main', created_at: '2026-08-18T00:00:00Z' }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    throw new Error(`unexpected fetch in test: ${url}`);
  }) as typeof fetch;
}

/**
 * Registers ONLY github_list_workflow_runs (not the full ~850-tool catalog -- registerAllTools
 * would need every OTHER tool's env vars satisfied too, which is unnecessary and slow here) on a
 * fresh McpServer, connects a real Client over a real InMemoryTransport pair, drives a real
 * tools/call through it, then tears both ends down.
 */
async function callThroughRealMcpServer(
  args: Record<string, unknown>,
  // Defaults to 'cto', which assertRepoAllowed always exempts -- see the RESTRICTED_TEST_REPO_ALLOWLIST
  // comment above for why this file runs under a fixed, non-empty DEVELOPER_ALLOWED_REPOS for its
  // whole lifetime. Tests that specifically exercise the allowlist pass 'developer' explicitly.
  callerAgent = 'cto',
): Promise<{ isError?: boolean; content: Array<{ type: string; text?: string }>; structuredContent?: unknown }> {
  const { registerGitHubListWorkflowRuns } = await import('./list-workflow-runs.js');
  const { requestContext } = await import('../../server/request-context.js');

  const mcp = new McpServer({ name: 'test', version: '0' }, { capabilities: { tools: { listChanged: true }, logging: {} } });
  registerGitHubListWorkflowRuns(mcp, () => 'test-caller-hash');

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0' }, { capabilities: {} });

  await Promise.all([mcp.connect(serverTransport), client.connect(clientTransport)]);
  try {
    // requestContext.run(...) here governs the AsyncLocalStorage context that is live while the
    // SERVER processes the call (InMemoryTransport.send() dispatches onmessage synchronously, so
    // the whole causal chain -- client.callTool -> transport.send -> server's onmessage -> our
    // handler's currentCallerAgent() read -- stays inside this same async continuation).
    return await requestContext.run(
      { callerHash: 'test-caller-hash', correlationId: 'test-correlation', callerAgent },
      () => client.callTool({ name: 'github_list_workflow_runs', arguments: args }) as ReturnType<typeof client.callTool>,
    );
  } finally {
    await client.close();
    await mcp.close();
  }
}

test('github_list_workflow_runs: status="waiting" reaches the real upstream GitHub request (the reported defect)', async () => {
  const urls: string[] = [];
  const result = await withStubbedFetch(githubStub(urls), () =>
    callThroughRealMcpServer({ owner: 'InnerScopeHearing', repo: 'otchealth-mcp-server', status: 'waiting' }),
  );
  assert.ok(!result.isError, `expected success, got: ${JSON.stringify(result)}`);
  const runsCall = urls.find((u) => u.includes('/actions/runs'));
  assert.ok(runsCall, 'expected the tool to actually call the GitHub actions/runs endpoint');
  assert.equal(
    new URL(runsCall!).searchParams.get('status'),
    'waiting',
    'status=waiting must reach the real upstream request -- pre-fix this key was silently stripped before the handler ever ran',
  );
});

test('github_list_workflow_runs: branch/event/actor/created/exclude_pull_requests/check_suite_id/head_sha/per_page/page all reach the upstream request', async () => {
  const urls: string[] = [];
  const result = await withStubbedFetch(githubStub(urls), () =>
    callThroughRealMcpServer({
      owner: 'InnerScopeHearing',
      repo: 'otchealth-mcp-server',
      branch: 'claude/gh-workflow-runs-filter',
      event: 'workflow_dispatch',
      actor: 'GBGolfMatt',
      created: '>=2026-08-01',
      exclude_pull_requests: true,
      check_suite_id: 4242,
      head_sha: 'deadbeefcafefeed',
      per_page: 7,
      page: 3,
    }),
  );
  assert.ok(!result.isError, `expected success, got: ${JSON.stringify(result)}`);
  const runsCall = urls.find((u) => u.includes('/actions/runs'));
  assert.ok(runsCall);
  const q = new URL(runsCall!).searchParams;
  assert.equal(q.get('branch'), 'claude/gh-workflow-runs-filter');
  assert.equal(q.get('event'), 'workflow_dispatch');
  assert.equal(q.get('actor'), 'GBGolfMatt');
  assert.equal(q.get('created'), '>=2026-08-01');
  assert.equal(q.get('exclude_pull_requests'), 'true');
  assert.equal(q.get('check_suite_id'), '4242');
  assert.equal(q.get('head_sha'), 'deadbeefcafefeed');
  assert.equal(q.get('per_page'), '7');
  assert.equal(q.get('page'), '3');
});

test('github_list_workflow_runs: an unrecognised status value is an EXPLICIT error, never a silently-unfiltered success', async () => {
  const urls: string[] = [];
  const result = await withStubbedFetch(githubStub(urls), () =>
    callThroughRealMcpServer({ owner: 'InnerScopeHearing', repo: 'otchealth-mcp-server', status: 'not_a_real_status' }),
  );
  assert.equal(result.isError, true, `an unsupported status value must be rejected, not silently ignored: ${JSON.stringify(result)}`);
  const text = result.content?.[0]?.text ?? '';
  assert.match(text, /status|invalid|arguments/i);
  assert.equal(urls.length, 0, 'an invalid status must fail BEFORE any upstream GitHub call is made (no partial success, no unfiltered fallback)');
});

test('github_list_workflow_runs: an entirely unknown extra argument does not silently change behavior or error confusingly', async () => {
  // Documents (does not newly fix) the deeper, fleet-wide platform behavior: a field name the tool
  // never declares at all is stripped by the SDK's own upstream parse before ANY tool-level code
  // runs, so it can never surface as a rejected/unrecognized-key error from an individual tool file.
  // This is expected today -- see the PR description's "adjacent finding" section. This test pins
  // the CURRENT (accurate) behavior: the call still succeeds (owner/repo alone are valid), and
  // getting a plain namematch for the endpoint is not misread as "the field was honored".
  const urls: string[] = [];
  const result = await withStubbedFetch(githubStub(urls), () =>
    callThroughRealMcpServer({ owner: 'InnerScopeHearing', repo: 'otchealth-mcp-server', this_is_not_a_real_field: 'whatever' }),
  );
  assert.ok(!result.isError, `expected success (owner/repo alone are valid): ${JSON.stringify(result)}`);
  const runsCall = urls.find((u) => u.includes('/actions/runs'));
  assert.ok(runsCall);
  assert.equal(new URL(runsCall!).searchParams.get('this_is_not_a_real_field'), null);
});

// ADDITIONAL finding beyond the reported defect (see the PR description): the pre-fix handler
// never called assertRepoAllowed() at all, unlike EVERY sibling github_* read tool in this
// codebase (list-pull-requests, issue-list, commit-list, release-list, repo-list-branches, ...
// all call it as their first line). That meant any non-cto/exec caller could list workflow runs
// for ANY repo the GitHub App installation reaches, bypassing DEVELOPER_ALLOWED_REPOS entirely.
// Both tests below run against the SAME fixed, restrictive allowlist set in before() (see
// RESTRICTED_TEST_REPO_ALLOWLIST) -- it deliberately does not include "otchealth-mcp-server".
test('github_list_workflow_runs: a non-cto/exec caller restricted by DEVELOPER_ALLOWED_REPOS to a DIFFERENT repo is rejected before any upstream call', async () => {
  const urls: string[] = [];
  const result = await withStubbedFetch(githubStub(urls), () =>
    callThroughRealMcpServer(
      { owner: 'InnerScopeHearing', repo: 'otchealth-mcp-server' },
      'developer',
    ),
  );
  assert.equal(result.isError, true, `a non-allowlisted repo must be refused for a non-cto/exec caller: ${JSON.stringify(result)}`);
  assert.equal(urls.length, 0, 'assertRepoAllowed must reject BEFORE any GitHub API call, not after');
});

test('github_list_workflow_runs: the cto lane always bypasses DEVELOPER_ALLOWED_REPOS (matches assertRepoAllowed elsewhere in the fleet)', async () => {
  const urls: string[] = [];
  const result = await withStubbedFetch(githubStub(urls), () =>
    callThroughRealMcpServer(
      { owner: 'InnerScopeHearing', repo: 'otchealth-mcp-server' },
      'cto',
    ),
  );
  assert.ok(!result.isError, `cto must bypass the repo allowlist, matching every sibling github_ read tool: ${JSON.stringify(result)}`);
  assert.ok(urls.some((u) => u.includes('/actions/runs')));
});
