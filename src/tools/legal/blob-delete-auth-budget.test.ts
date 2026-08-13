// Regression test for Copilot review PR #192 round 3: legal_blob_delete's bulk loop used to await
// prepareDeindexAuth() BEFORE any blob had moved, sharing the SAME clock (`startedAt`) the move
// loop's own time-budget check used. A slow (but eventually successful) auth resolution could
// therefore consume the whole batch budget before the first item even started, turning best-effort
// cleanup into an outage of the tool's PRIMARY function (a batch that should have moved blobs
// instead reports status:'partial' with ZERO moves). The fix decouples the two clocks: the move
// loop's budget starts fresh (`moveStartedAt`) only AFTER auth resolves, however long that took.
//
// Isolated in its OWN file/process (not added to blob-deindex-configured.test.ts) so this test's
// small LEGAL_DELETE_TIME_BUDGET_MS (the env floor, 1000ms) cannot affect that file's other tests,
// which share a process-wide memoized env (config/env.ts's loadEnv()).
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.CIO_SITE_ID ||= 'test';
process.env.CIO_TRACK_KEY ||= 'test';
process.env.CIO_APP_API_BEARER ||= 'test';
process.env.PERPLEXITY_CONNECTOR_TOKEN ||= 'x'.repeat(32);
process.env.ADMIN_REVOKE_TOKEN ||= 'x'.repeat(32);
process.env.N8N_WEBHOOK_SECRET ||= 'x'.repeat(32);
process.env.AZURE_LEGAL_STORAGE_ACCOUNT ||= 'otchealthlegalstore';
process.env.AZURE_LEGAL_STORAGE_KEY ||= Buffer.from('unit-test-key-not-real').toString('base64');
process.env.AZURE_SEARCH_ENDPOINT ||= 'https://otchealth-dataroom-s1.search.windows.net';
process.env.IDENTITY_ENDPOINT ||= 'http://fake-identity.example.invalid/msi/token';
process.env.IDENTITY_HEADER ||= 'fake-identity-header-secret';
process.env.LEGAL_DELETE_TIME_BUDGET_MS ||= '1000'; // the configured floor

const { handleLegalBlobDelete, effectiveMoveBudgetMs } = await import('./blob-delete.js');

// Regression for Copilot review PR #192 round 7: round 3's fix decoupled the move loop's budget
// clock from auth resolution time so a slow auth call could never STARVE moves (moveStartedAt
// begins fresh only after auth resolves) -- but that also meant auth's own latency was silently NOT
// counted against anything, quietly eroding the margin LEGAL_DELETE_TIME_BUDGET_MS was tuned to
// leave under the 60s MCP transport timeout (config/env.ts:369-377's 35s+20s=55s worst case assumed
// auth was free). effectiveMoveBudgetMs is the fix: subtract auth's real elapsed time from the
// move loop's budget, floored so it can still never be fully starved. Tested directly as a pure
// function (no timers, no stubbed fetch) since the logic is a one-line Math.max.
test('effectiveMoveBudgetMs: normal case subtracts auth latency from the configured budget', () => {
  assert.equal(effectiveMoveBudgetMs(30_000, 500), 29_500);
  assert.equal(effectiveMoveBudgetMs(30_000, 0), 30_000, 'an instant auth resolution costs nothing');
});

test('effectiveMoveBudgetMs: floors at 1000ms (the same minimum LEGAL_DELETE_TIME_BUDGET_MS itself enforces) -- never fully starves the move loop, preserving round 3\'s guarantee', () => {
  assert.equal(effectiveMoveBudgetMs(1000, 3000), 1000, 'auth alone eating the whole configured budget must not zero out the move loop\'s budget');
  assert.equal(effectiveMoveBudgetMs(1000, 999), 1000, 'right at the boundary still floors correctly');
});

function withStubbedFetch<T>(stub: typeof fetch, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  return run().finally(() => {
    globalThis.fetch = original;
  });
}

function fakeCtx(callerAgent: string, dryRun = false) {
  return { correlationId: 'test-corr', callerHash: 'test-hash', dryRun, acknowledgeWarning: false, callerAgent };
}

const isBlobCall = (u: string) => {
  try { return new URL(u).hostname === `${process.env.AZURE_LEGAL_STORAGE_ACCOUNT}.blob.core.windows.net`; } catch { return false; }
};
const isIdentityCall = (u: string) => {
  try { return new URL(u).hostname === 'fake-identity.example.invalid'; } catch { return false; }
};

test('legal_blob_delete: a slow-but-successful auth resolution does NOT consume the move-time budget -- the blob still moves', async () => {
  const xml = `<?xml version="1.0"?><EnumerationResults>
    <Blobs><Blob><Name>dupes/a.pdf</Name><Content-Length>10</Content-Length></Blob></Blobs>
  </EnumerationResults>`;
  const AUTH_DELAY_MS = 1500; // longer than the 1000ms move budget, but under prepareDeindexAuth's own ~3s cap
  const result = await withStubbedFetch(
    (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      const method = init?.method || 'GET';
      if (isIdentityCall(u)) {
        await new Promise((resolve) => setTimeout(resolve, AUTH_DELAY_MS));
        return new Response(
          JSON.stringify({ access_token: 'fake.token', expires_on: String(Math.floor(Date.now() / 1000) + 3600) }),
          { status: 200 },
        );
      }
      if (u.includes('listAdminKeys')) return new Response(JSON.stringify({ primaryKey: 'fake-admin-key' }), { status: 200 });
      if (u.includes('/docs/search')) return new Response(JSON.stringify({ value: [] }), { status: 200 }); // nothing indexed yet -- fine, only testing the move itself
      if (isBlobCall(u)) {
        if (method === 'GET') return new Response(xml, { status: 200 });
        if (method === 'HEAD') return new Response(null, { status: 404 }); // no trash collision
        if (method === 'PUT') return new Response(null, { status: 202, headers: { 'x-ms-copy-status': 'success', 'content-length': '10' } });
        if (method === 'DELETE') return new Response(null, { status: 202 });
      }
      throw new Error(`unexpected call: ${method} ${u}`);
    }) as typeof fetch,
    () => handleLegalBlobDelete({ container: 'personal', prefix: 'dupes/', confirm: 'dupes/' }, fakeCtx('clo-personal', false)),
  );

  assert.equal((result.data as any).matched, 1);
  assert.equal((result.data as any).moved.length, 1, 'the blob must still move despite auth taking longer than the whole move budget -- proves the two clocks are decoupled');
  assert.equal((result.data as any).executed, true);
  assert.equal((result.data as any).status, 'complete', 'a single small item must complete cleanly on its own fresh budget, unaffected by how long auth took');
});
