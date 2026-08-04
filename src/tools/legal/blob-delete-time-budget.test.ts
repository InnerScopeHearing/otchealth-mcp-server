import { test } from 'node:test';
import assert from 'node:assert/strict';

// A SEPARATE process/file from blob-delete.test.ts (node --test isolates each matched file into its
// own process) specifically so a tiny LEGAL_DELETE_TIME_BUDGET_MS can be set here without touching
// the main suite's generous default -- these tests trade a little real wall-clock time (a genuine
// injected delay, not a flaky race) for a deterministic proof that the time-budget partial-stop path
// actually works (2026-08-04, CLO field report Finding 1: a real 147-item bulk delete exceeded the
// 60s MCP transport timeout with no partial-progress signal to the caller).
process.env.CIO_SITE_ID ||= 'test';
process.env.CIO_TRACK_KEY ||= 'test';
process.env.CIO_APP_API_BEARER ||= 'test';
process.env.PERPLEXITY_CONNECTOR_TOKEN ||= 'x'.repeat(32);
process.env.ADMIN_REVOKE_TOKEN ||= 'x'.repeat(32);
process.env.N8N_WEBHOOK_SECRET ||= 'x'.repeat(32);
process.env.AZURE_LEGAL_STORAGE_ACCOUNT ||= 'otchealthlegalstore';
process.env.AZURE_LEGAL_STORAGE_KEY ||= Buffer.from('unit-test-key-not-real').toString('base64');
// The schema's floor (1000ms). A single injected 1200ms real delay on the first item reliably trips
// this budget before the second item starts, with a comfortable margin -- deterministic in both
// directions (never flaky-passes on a slow CI runner, never flaky-fails on a fast one).
process.env.LEGAL_DELETE_TIME_BUDGET_MS ||= '1000';
const INJECTED_DELAY_MS = 1200;

const { handleLegalBlobDelete } = await import('./blob-delete.js');

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

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('bulk delete (live): stops at the time budget mid-batch, status:partial, accurate remaining, no lost accounting', async () => {
  const xml = `<?xml version="1.0"?><EnumerationResults>
    <Blobs><Blob><Name>dupes/a.pdf</Name><Content-Length>10</Content-Length></Blob></Blobs>
    <Blobs><Blob><Name>dupes/b.pdf</Name><Content-Length>10</Content-Length></Blob></Blobs>
    <Blobs><Blob><Name>dupes/c.pdf</Name><Content-Length>10</Content-Length></Blob></Blobs>
  </EnumerationResults>`;
  let putCalls = 0;
  const stub: typeof fetch = (async (_url, init?: RequestInit) => {
    const method = init?.method || 'GET';
    if (method === 'GET') return new Response(xml, { status: 200 });
    if (method === 'HEAD') return new Response(null, { status: 404 }); // never a trash collision
    if (method === 'PUT') {
      putCalls += 1;
      if (putCalls === 1) await delay(INJECTED_DELAY_MS); // real delay: guarantees the budget trips before item 2
      return new Response(null, { status: 202, headers: { 'x-ms-copy-status': 'success' } });
    }
    if (method === 'DELETE') return new Response(null, { status: 202 });
    throw new Error(`unexpected ${method}`);
  }) as typeof fetch;
  const res = await withStubbedFetch(stub, () =>
    handleLegalBlobDelete({ container: 'personal', prefix: 'dupes/', confirm: 'dupes/' }, fakeCtx('clo-personal', false)),
  );
  const data = res.data as { status: string; executed: boolean; moved: unknown[]; remaining: number; matched: number; as_of: string };
  assert.equal(data.status, 'partial');
  assert.equal(data.executed, true, 'at least one item moved before the budget stop -- this is a partial execution, not a no-op');
  assert.equal(data.moved.length, 1, 'only the first (delayed) item completes before the budget trips');
  assert.equal(data.matched, 3);
  assert.equal(data.remaining, 2, 'the two un-started items are honestly reported as remaining, not silently lost');
  assert.equal(typeof data.as_of, 'string');
  assert.ok(data.as_of.length > 0 && !Number.isNaN(Date.parse(data.as_of)), 'as_of must be a real parseable timestamp');
});

test('bulk delete dry_run: the collision-preflight loop is ALSO time-budgeted and reports status:partial', async () => {
  const xml = `<?xml version="1.0"?><EnumerationResults>
    <Blobs><Blob><Name>dupes/a.pdf</Name><Content-Length>10</Content-Length></Blob></Blobs>
    <Blobs><Blob><Name>dupes/b.pdf</Name><Content-Length>10</Content-Length></Blob></Blobs>
  </EnumerationResults>`;
  let headCalls = 0;
  const stub: typeof fetch = (async (_url, init?: RequestInit) => {
    const method = init?.method || 'GET';
    if (method === 'GET') return new Response(xml, { status: 200 });
    if (method === 'HEAD') {
      headCalls += 1;
      if (headCalls === 1) await delay(INJECTED_DELAY_MS);
      return new Response(null, { status: 404 }); // no collision
    }
    throw new Error(`must not ${method} in dry_run`);
  }) as typeof fetch;
  const res = await withStubbedFetch(stub, () =>
    handleLegalBlobDelete({ container: 'personal', prefix: 'dupes/', confirm: 'dupes/' }, fakeCtx('clo-personal', true)),
  );
  const data = res.data as { status: string; dry_run: boolean; moved: unknown[]; collisions: unknown[]; remaining: number };
  assert.equal(data.dry_run, true);
  assert.equal(data.status, 'partial');
  assert.equal(data.moved.length, 1, 'the one item checked before the budget tripped');
  assert.equal(data.collisions.length, 0);
  assert.equal(data.remaining, 1, 'the unchecked item is reported, not silently omitted from the plan');
});

test('single mode success: status is always complete, remaining 0, and as_of is a real timestamp (single-item delete never approaches the budget)', async () => {
  let headCount = 0;
  const stub: typeof fetch = (async (_url, init?: RequestInit) => {
    const method = init?.method || 'GET';
    if (method === 'HEAD') {
      headCount += 1;
      return new Response(null, { status: headCount === 1 ? 200 : 404 });
    }
    if (method === 'PUT') return new Response(null, { status: 202, headers: { 'x-ms-copy-status': 'success' } });
    if (method === 'DELETE') return new Response(null, { status: 202 });
    throw new Error(`unexpected ${method}`);
  }) as typeof fetch;
  const res = await withStubbedFetch(stub, () =>
    handleLegalBlobDelete({ container: 'personal', path: 'a.pdf', confirm: 'a.pdf' }, fakeCtx('clo-personal', false)),
  );
  const data = res.data as { status: string; remaining: number; as_of: string; executed: boolean };
  assert.equal(data.executed, true);
  assert.equal(data.status, 'complete');
  assert.equal(data.remaining, 0);
  assert.ok(data.as_of.length > 0 && !Number.isNaN(Date.parse(data.as_of)));
});
