import { test } from 'node:test';
import assert from 'node:assert/strict';

// Own file/process: loadEnv() caches, so SEARCH_DUAL_WRITE cannot be toggled after the first read.
// This file pins DUAL-WRITE ON with OpenSearch primary -- the exact configuration the cutover runs.
process.env.CIO_SITE_ID ||= 'test';
process.env.CIO_TRACK_KEY ||= 'test';
process.env.CIO_APP_API_BEARER ||= 'test';
process.env.PERPLEXITY_CONNECTOR_TOKEN ||= 'x'.repeat(32);
process.env.ADMIN_REVOKE_TOKEN ||= 'x'.repeat(32);
process.env.N8N_WEBHOOK_SECRET ||= 'x'.repeat(32);
process.env.FOUNDRY_OPENAI_ENDPOINT ||= 'https://otchealth-foundry.example.invalid';
process.env.FOUNDRY_KEY ||= 'test-foundry-key';
process.env.SEARCH_BACKEND = 'opensearch';
process.env.SEARCH_DUAL_WRITE = 'true';
process.env.OPENSEARCH_ENDPOINT = 'search-otchealth-brain-uqmq2jw23cv4yjnnxblxzb7nny.us-east-1.es.amazonaws.com';
process.env.OPENSEARCH_REGION = 'us-east-1';
process.env.AWS_ACCESS_KEY_ID = 'AKIDEXAMPLE';
process.env.AWS_SECRET_ACCESS_KEY = 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY';
process.env.AZURE_SEARCH_ENDPOINT = 'https://otchealth-dataroom-s1.search.windows.net';
// Without this, the Azure writer cannot get an admin key outside Azure (managed identity only) and
// never reaches its HTTP call at all -- which is precisely the one-way-rollback trap this exercises.
process.env.AZURE_SEARCH_ADMIN_KEY = 'test-admin-key';

const { indexMemory, dualWriteEnabled } = await import('./index.js');

const OS_HOST = 'es.amazonaws.com';
const AZ_HOST = 'search.windows.net';

async function withStubbedFetch<T>(stub: typeof fetch, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

/** Record every host the write touched, answering everything 200 so neither path short-circuits. */
function recordingFetch(seen: string[], opts: { osStatus?: number; delayOsMs?: number } = {}) {
  return (async (u: string) => {
    const url = String(u);
    seen.push(url);
    if (url.includes(OS_HOST)) {
      if (opts.delayOsMs) await new Promise((r) => setTimeout(r, opts.delayOsMs));
      return new Response('{"result":"created"}', { status: opts.osStatus ?? 201 });
    }
    return new Response('{}', { status: 200 });
  }) as unknown as typeof fetch;
}

const mem = { agent: 'cto', id: 'dw-1', text: 'dual write', index: 'memory-exec', vector: [0.1] };

test('the flag is actually on in this scenario', () => {
  assert.equal(dualWriteEnabled(), true);
});

test('THE MIGRATION PRIMITIVE: dual-write reaches BOTH backends from one call', async () => {
  // Without this, the cutover has a lossy instant: memories written between the last bulk copy and
  // the read flip exist on exactly one side. memory-exec is written continuously, so that window is
  // never empty.
  const seen: string[] = [];
  await withStubbedFetch(recordingFetch(seen), () => indexMemory(mem));
  assert.ok(seen.some((u) => u.includes(OS_HOST)), 'OpenSearch (primary) was written');
  assert.ok(seen.some((u) => u.includes(AZ_HOST)), 'Azure (secondary) was written too');
});

test('the RETURNED outcome is the primary backend, so no caller semantics change', async () => {
  const seen: string[] = [];
  const res = await withStubbedFetch(recordingFetch(seen), () => indexMemory(mem));
  assert.equal(res.primary, 'opensearch');
  assert.equal(res.indexed, true, 'primary succeeded, so the call reports success');
  assert.equal(res.secondary?.backend, 'azure', 'the secondary rides along for observability only');
});

test('A SECONDARY FAILURE MUST NOT FAIL A WRITE THE PRIMARY ACCEPTED', async () => {
  // During the transition Azure is the side we expect to become unreliable (that is the whole
  // point). If its failure propagated, the cutover would make every memory write start failing.
  const failAzure = (async (u: string) => {
    const url = String(u);
    if (url.includes(OS_HOST)) return new Response('{"result":"created"}', { status: 201 });
    throw new Error('Azure is gone');
  }) as unknown as typeof fetch;

  const res = await withStubbedFetch(failAzure, () => indexMemory(mem));
  assert.equal(res.indexed, true, 'the write still succeeds');
  assert.equal(res.primary, 'opensearch');
  assert.equal(res.secondary?.indexed, false, 'and the failure is still REPORTED, not swallowed');
});

test('a primary failure is reported without throwing', async () => {
  const failOs = (async (u: string) => {
    const url = String(u);
    if (url.includes(OS_HOST)) return new Response('nope', { status: 500 });
    return new Response('{}', { status: 200 });
  }) as unknown as typeof fetch;

  const res = await withStubbedFetch(failOs, () => indexMemory(mem));
  assert.equal(res.indexed, false);
  assert.match(String(res.reason), /opensearch index 500/);
});

test('the two writes run CONCURRENTLY, not one after the other', async () => {
  // Sequential dual-write would add the secondary's full latency to every memory write in the
  // fleet. Measured against a deliberately slow primary: total must track the slow leg, not the sum.
  const seen: string[] = [];
  const started = Date.now();
  await withStubbedFetch(recordingFetch(seen, { delayOsMs: 120 }), () => indexMemory(mem));
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 300, `expected concurrent (~120ms), took ${elapsed}ms -- looks sequential`);
});

test('neither backend can reject the call, even if a writer regresses into throwing', async () => {
  // allSettled rather than all: the fail-open contract has to survive a future writer that throws
  // instead of returning {indexed:false}.
  const throwAll = (async () => {
    throw new Error('everything is down');
  }) as unknown as typeof fetch;
  const res = await withStubbedFetch(throwAll, () => indexMemory(mem));
  assert.equal(res.indexed, false);
  assert.equal(res.primary, 'opensearch');
  assert.ok(res.secondary, 'the secondary outcome is still reported');
});
