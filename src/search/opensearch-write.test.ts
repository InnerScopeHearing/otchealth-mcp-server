import { test } from 'node:test';
import assert from 'node:assert/strict';

// Own file/process -- loadEnv() caches on first call, so an env scenario cannot be changed later.
process.env.CIO_SITE_ID ||= 'test';
process.env.CIO_TRACK_KEY ||= 'test';
process.env.CIO_APP_API_BEARER ||= 'test';
process.env.PERPLEXITY_CONNECTOR_TOKEN ||= 'x'.repeat(32);
process.env.ADMIN_REVOKE_TOKEN ||= 'x'.repeat(32);
process.env.N8N_WEBHOOK_SECRET ||= 'x'.repeat(32);
process.env.FOUNDRY_OPENAI_ENDPOINT ||= 'https://otchealth-foundry.example.invalid';
process.env.FOUNDRY_KEY ||= 'test-foundry-key';
process.env.SEARCH_BACKEND = 'opensearch';
process.env.OPENSEARCH_ENDPOINT = 'search-otchealth-brain-uqmq2jw23cv4yjnnxblxzb7nny.us-east-1.es.amazonaws.com';
process.env.OPENSEARCH_REGION = 'us-east-1';
process.env.AWS_ACCESS_KEY_ID = 'AKIDEXAMPLE';
process.env.AWS_SECRET_ACCESS_KEY = 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY';

const { buildOpenSearchMemoryDoc, indexMemoryNowOpenSearch } = await import('./opensearch-write.js');

async function withStubbedFetch<T>(stub: typeof fetch, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

const base = { agent: 'cto', id: '20260815-001', text: 'the cutover write path', tags: ['aws', 'brain'] };

test('THE SILENT KILLER: the vector field name is per-room, not fixed', () => {
  // A flat memory room indexes `contentVector`; a chunked doc room indexes `text_vector`. Writing
  // the wrong name yields a document that is keyword-findable but INVISIBLE to vector recall --
  // no error, just quietly worse memory. This must match vectorFieldFor exactly.
  const flat = buildOpenSearchMemoryDoc({ ...base, vector: [0.1, 0.2] }, 'memory-exec');
  assert.ok('contentVector' in flat, 'flat memory rooms use contentVector');
  assert.equal('text_vector' in flat, false);

  const chunked = buildOpenSearchMemoryDoc({ ...base, vector: [0.1, 0.2] }, 'legal-company');
  assert.ok('text_vector' in chunked, 'chunked doc rooms use text_vector');
  assert.equal('contentVector' in chunked, false);
});

test('the Azure-only bulk directive is NOT carried into OpenSearch', () => {
  // `@search.action` is an Azure Search bulk-protocol field. OpenSearch would store it as a literal
  // document field, which is junk at best and a mapping conflict at worst.
  const doc = buildOpenSearchMemoryDoc({ ...base, vector: null }, 'memory-exec');
  assert.equal('@search.action' in doc, false);
});

test('the document id matches Azure exactly, or reads by key silently miss', () => {
  // getDocumentByKey fetches /{index}/_doc/{key} using the Azure-derived id. If the two diverge,
  // every fetch-by-key returns nothing while the document plainly exists.
  const doc = buildOpenSearchMemoryDoc({ ...base, vector: null }, 'memory-exec');
  assert.equal(doc.id, 'cto__20260815-001');
});

test('field shape mirrors the Azure writer so both copies read identically', () => {
  const doc = buildOpenSearchMemoryDoc(
    { agent: 'cfo', id: 'x1', type: 'decision', ts: '2026-08-15T00:00:00Z', tags: ['a', 'b'], text: 'hello', vector: null },
    'memory-exec',
  );
  assert.equal(doc.agent, 'cfo');
  assert.equal(doc.type, 'decision');
  assert.equal(doc.ts, '2026-08-15T00:00:00Z');
  assert.equal(doc.tags, 'a, b', 'tags stay a comma-joined STRING, as Azure stores them');
  assert.equal(doc.text, 'hello');
});

test('missing optional fields become empty strings, never undefined', () => {
  // undefined would serialise away entirely and leave the two backends holding different shapes.
  const doc = buildOpenSearchMemoryDoc({ agent: 'cto', id: 'x', text: 't', vector: null }, 'memory-exec');
  assert.equal(doc.type, '');
  assert.equal(doc.ts, '');
  assert.equal(doc.tags, '');
});

test('text is truncated at the same limit as Azure', () => {
  const doc = buildOpenSearchMemoryDoc({ ...base, text: 'z'.repeat(20000), vector: null }, 'memory-exec');
  assert.equal(String(doc.text).length, 16000, 'divergent truncation would make the two copies differ');
});

test('a vectorless memory is still written -- degrade, never drop', () => {
  const doc = buildOpenSearchMemoryDoc({ ...base, vector: null }, 'memory-exec');
  assert.equal('contentVector' in doc, false);
  assert.equal(doc.text, 'the cutover write path', 'the memory itself survives without an embedding');
});

test('writes PUT to the doc id with refresh=wait_for', async () => {
  let seenUrl = '';
  let seenMethod = '';
  const res = await withStubbedFetch(
    (async (u: string, init?: RequestInit) => {
      seenUrl = String(u);
      seenMethod = String(init?.method);
      return new Response('{"result":"created"}', { status: 201 });
    }) as unknown as typeof fetch,
    () => indexMemoryNowOpenSearch({ ...base, vector: [0.1], index: 'memory-exec' }),
  );
  assert.equal(res.indexed, true);
  assert.equal(seenMethod, 'PUT');
  assert.match(seenUrl, /\/memory-exec\/_doc\/cto__20260815-001/);
  // Without wait_for, a memory written and recalled moments later in the same turn is NOT found,
  // which is indistinguishable from the amnesia bug this whole path exists to fix.
  assert.match(seenUrl, /refresh=wait_for/);
});

test('FAIL-OPEN: a rejected write reports the reason and never throws', async () => {
  const res = await withStubbedFetch(
    (async () => new Response('mapper_parsing_exception', { status: 400 })) as unknown as typeof fetch,
    () => indexMemoryNowOpenSearch({ ...base, vector: null, index: 'memory-exec' }),
  );
  assert.equal(res.indexed, false);
  assert.match(String(res.reason), /opensearch index 400/);
  assert.equal(res.docId, 'cto__20260815-001', 'the caller still learns which doc failed');
});

test('FAIL-OPEN: a thrown network error is caught, not propagated', async () => {
  // A memory write must never fail because an index was unreachable.
  const res = await withStubbedFetch(
    (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch,
    () => indexMemoryNowOpenSearch({ ...base, vector: null, index: 'memory-exec' }),
  );
  assert.equal(res.indexed, false);
  assert.match(String(res.reason), /ECONNREFUSED/);
});

test('index names are URL-encoded so an odd room name cannot break the path', async () => {
  let seenUrl = '';
  await withStubbedFetch(
    (async (u: string) => {
      seenUrl = String(u);
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch,
    () => indexMemoryNowOpenSearch({ ...base, vector: null, index: 'weird room' }),
  );
  assert.match(seenUrl, /weird%20room/);
});
