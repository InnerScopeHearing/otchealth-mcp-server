import assert from 'node:assert/strict';
import test from 'node:test';
import { createRelationshipArtifactS3, relationshipArtifactS3Test as helper } from './relationship-artifact-s3.js';
import type { AwsCredentials } from '../search/sigv4.js';

const CREDS: AwsCredentials = {
  accessKeyId: 'AKIDEXAMPLE',
  secretAccessKey: 'synthetic-secret-for-tests-only',
};
const RUN = 'run_' + 'a'.repeat(64);
const SHA = 'a'.repeat(64);
const artifactKey = `graph-trial/20260908/workers/cfo/${RUN}/relationship-producers/relationship-resolver/resolution-artifacts/sha256/aa/${SHA}.json`;
const stateKey = `graph-trial/20260908/workers/cfo/${RUN}/active-runs/${SHA}.json`;

function transport(overrides: {
  fetch?: typeof fetch;
  sign?: (input: Parameters<NonNullable<Parameters<typeof createRelationshipArtifactS3>[0]>['signRequest']>[0]) => { headers: Record<string, string> };
} = {}) {
  return createRelationshipArtifactS3({
    resolveCredentials: async () => CREDS,
    signRequest: overrides.sign ?? (() => ({ headers: { authorization: 'synthetic' } })),
    fetch: overrides.fetch ?? (async () => new Response('ok')),
  });
}

test('relationship artifact S3 signs the exact versionId query and sends its canonical wire target', async () => {
  let signed: Parameters<NonNullable<Parameters<typeof createRelationshipArtifactS3>[0]>['signRequest']>[0] | undefined;
  let seenUrl = '';
  const s3 = transport({
    sign: (input) => {
      signed = input;
      return { headers: { authorization: 'synthetic' } };
    },
    fetch: async (url) => {
      seenUrl = String(url);
      return new Response('ok');
    },
  });
  const versionId = 'opaque+/=%✓';
  const result = await s3({ method: 'GET', key: artifactKey, versionId, signal: new AbortController().signal });
  assert.equal(result.body.toString(), 'ok');
  assert.deepEqual(signed?.query, { versionId });
  assert.equal(
    seenUrl,
    `https://${helper.BUCKET}.s3.${helper.REGION}.amazonaws.com/${artifactKey}?versionId=opaque%2B%2F%3D%25%E2%9C%93`,
  );
});

test('relationship artifact S3 only permits the immutable CFO namespace and pins PUT away from versions', async () => {
  const s3 = transport();
  await assert.rejects(
    s3({ method: 'GET', key: `other-bucket/${artifactKey}`, signal: new AbortController().signal }), /key/,
  );
  await assert.rejects(
    s3({ method: 'GET', key: artifactKey.replace('/aa/', '/bb/'), signal: new AbortController().signal }), /key/,
  );
  await assert.rejects(
    s3({ method: 'PUT', key: artifactKey, versionId: 'v1', body: Buffer.from('{}'), signal: new AbortController().signal }), /version/,
  );
  await assert.rejects(
    s3({ method: 'GET', key: stateKey, versionId: 'bad\u0000version', signal: new AbortController().signal }), /version/,
  );
  await assert.rejects(
    s3({ method: 'GET', key: stateKey, versionId: 'null', signal: new AbortController().signal }), /version/,
  );
  await assert.rejects(
    s3({ method: 'GET', key: stateKey, versionId: 'has space', signal: new AbortController().signal }), /version/,
  );
});

test('relationship artifact S3 requires immutable PUT preconditions and never writes active-run state', async () => {
  const s3 = transport();
  await assert.rejects(
    s3({ method: 'PUT', key: artifactKey, body: Buffer.from('{}'), signal: new AbortController().signal }), /precondition/,
  );
  await assert.rejects(
    s3({ method: 'PUT', key: artifactKey, headers: { 'if-none-match': '*', 'if-match': '"old"' }, body: Buffer.from('{}'), signal: new AbortController().signal }), /precondition/,
  );
  await assert.rejects(
    s3({ method: 'PUT', key: stateKey, headers: { 'if-none-match': '*' }, body: Buffer.from('{}'), signal: new AbortController().signal }), /precondition/,
  );
  await assert.rejects(
    s3({ method: 'PUT', key: artifactKey, headers: { 'if-none-match': '*' }, body: Buffer.alloc(helper.MAX_RESPONSE_BYTES + 1), signal: new AbortController().signal }), /body/,
  );
});

test('relationship artifact S3 refuses an already-aborted request before resolving credentials', async () => {
  let credentialCalls = 0;
  const controller = new AbortController();
  controller.abort();
  const s3 = createRelationshipArtifactS3({
    resolveCredentials: async () => { credentialCalls++; return CREDS; },
    fetch: async () => new Response('unreachable'),
  });
  await assert.rejects(
    s3({ method: 'GET', key: stateKey, signal: controller.signal }), /deadline/,
  );
  assert.equal(credentialCalls, 0);
});

test('relationship artifact S3 rejects declared and streamed responses above the caller bound', async () => {
  const limit = 3;
  const declared = transport({
    fetch: async () => new Response('four', { headers: { 'content-length': '4' } }),
  });
  await assert.rejects(
    declared({ method: 'GET', key: stateKey, maxBytes: limit, signal: new AbortController().signal }), /response_size/,
  );
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(Buffer.from('four'));
      controller.close();
    },
  });
  const chunked = transport({ fetch: async () => new Response(stream) });
  await assert.rejects(
    chunked({ method: 'GET', key: stateKey, maxBytes: limit, signal: new AbortController().signal }), /response_size/,
  );
});

test('relationship artifact S3 rejects malformed content length and uses a non-following redirect policy', async () => {
  let redirect: RequestRedirect | undefined;
  const s3 = transport({
    fetch: async (_url, init) => {
      redirect = init?.redirect;
      return new Response('ok', { headers: { 'content-length': 'wat' } });
    },
  });
  await assert.rejects(
    s3({ method: 'GET', key: stateKey, signal: new AbortController().signal }), /response_size/,
  );
  assert.equal(redirect, 'error');
});

test('relationship artifact S3 rejects a response whose declared length differs from the stream', async () => {
  const s3 = transport({
    fetch: async () => new Response('ok', { headers: { 'content-length': '3' } }),
  });
  await assert.rejects(
    s3({ method: 'GET', key: stateKey, signal: new AbortController().signal }), /response_size/,
  );
});
