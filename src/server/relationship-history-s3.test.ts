import assert from 'node:assert/strict';
import test from 'node:test';
import { createRelationshipHistoryS3, relationshipHistoryS3Test as helper } from './relationship-history-s3.js';
import type { AwsCredentials } from '../search/sigv4.js';

const CREDS: AwsCredentials = { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'synthetic-test-secret' };
const RUN = 'run_' + 'a'.repeat(64);
const SHA = 'a'.repeat(64);
const ARTIFACT = `graph-trial/20260908/workers/cfo/${RUN}/relationship-producers/relationship-resolver/resolution-artifacts/sha256/aa/${SHA}.json`;
const ADMISSION = `graph-trial/20260908/catalog-cohorts/synthetic/server/admissions/${RUN}.json`;
const PROPOSAL = `graph-trial/20260908/catalog-cohorts/synthetic/server/proposals/${SHA}.json`;
type SignInput = Parameters<NonNullable<NonNullable<Parameters<typeof createRelationshipHistoryS3>[0]>['signRequest']>>[0];

function reader(overrides: { fetch?: typeof fetch; sign?: (input: SignInput) => { headers: Record<string, string> } } = {}) {
  return createRelationshipHistoryS3({
    resolveCredentials: async () => CREDS,
    signRequest: overrides.sign ?? (() => ({ headers: { authorization: 'synthetic' } })),
    fetch: overrides.fetch ?? (async () => new Response('ok')),
  });
}

test('history S3 signs an opaque versionId exactly and emits the canonical wire query', async () => {
  let signed: SignInput | undefined, url = '';
  const readVersion = reader({
    sign: (input) => { signed = input; return { headers: { authorization: 'synthetic' } }; },
    fetch: async (input) => { url = String(input); return new Response('ok'); },
  });
  const versionId = 'opaque+/=%✓';
  const result = await readVersion.readVersion({ key: ARTIFACT, versionId, maxBytes: 32, signal: new AbortController().signal });
  assert.equal(result.body.toString(), 'ok');
  assert.deepEqual(signed?.query, { versionId });
  assert.equal(url, `https://${helper.BUCKET}.s3.${helper.REGION}.amazonaws.com/${ARTIFACT}?versionId=opaque%2B%2F%3D%25%E2%9C%93`);
});

test('history S3 allows only pinned artifact and explicit cohort receipt paths', async () => {
  const readVersion = reader();
  for (const key of [ARTIFACT, ADMISSION, PROPOSAL]) {
    await readVersion.readVersion({ key, versionId: 'v1', maxBytes: 32, signal: new AbortController().signal });
  }
  for (const key of [
    `graph-trial/20260908/workers/cfo/${RUN}/active-runs/${SHA}.json`,
    ARTIFACT.replace('/aa/', '/bb/'),
    `graph-trial/20260908/catalog-cohorts/synthetic/server/admissions/${SHA}.json`,
    `graph-trial/20260908/catalog-cohorts/synthetic/server/proposals/${RUN}.json/extra`,
    `https://elsewhere/${ARTIFACT}`,
  ]) {
    await assert.rejects(readVersion.readVersion({ key, versionId: 'v1', maxBytes: 32, signal: new AbortController().signal }), /key/);
  }
});

test('history S3 requires a non-null, non-whitespace opaque version', async () => {
  const readVersion = reader();
  for (const versionId of ['', 'null', 'with space', 'bad\u0000value']) {
    await assert.rejects(readVersion.readVersion({ key: ARTIFACT, versionId, maxBytes: 32, signal: new AbortController().signal }), /version/);
  }
});

test('history S3 enforces declared, streamed, and actual response length bounds without redirects', async () => {
  let redirect: RequestRedirect | undefined;
  const declared = reader({ fetch: async (_url, init) => { redirect = init?.redirect; return new Response('four', { headers: { 'content-length': '4' } }); } });
  await assert.rejects(declared.readVersion({ key: ARTIFACT, versionId: 'v1', maxBytes: 3, signal: new AbortController().signal }), /response_size/);
  assert.equal(redirect, 'error');
  const chunked = reader({ fetch: async () => new Response(new ReadableStream<Uint8Array>({ start(c) { c.enqueue(Buffer.from('four')); c.close(); } })) });
  await assert.rejects(chunked.readVersion({ key: ARTIFACT, versionId: 'v1', maxBytes: 3, signal: new AbortController().signal }), /response_size/);
  const mismatch = reader({ fetch: async () => new Response('ok', { headers: { 'content-length': '3' } }) });
  await assert.rejects(mismatch.readVersion({ key: ARTIFACT, versionId: 'v1', maxBytes: 32, signal: new AbortController().signal }), /response_size/);
});

test('history S3 never resolves credentials for an already-aborted read', async () => {
  let credentials = 0;
  const controller = new AbortController(); controller.abort();
  const readVersion = createRelationshipHistoryS3({
    resolveCredentials: async () => { credentials++; return CREDS; },
    fetch: async () => new Response('unreachable'),
  });
  await assert.rejects(readVersion.readVersion({ key: ARTIFACT, versionId: 'v1', maxBytes: 32, signal: controller.signal }), /deadline/);
  assert.equal(credentials, 0);
});
