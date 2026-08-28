import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * The HeyGen artifact store's Azure-exit S3 port (2026-08-28). Own file: BLOB_BACKEND must be set
 * before loadEnv() caches, and this file exercises the S3 branch specifically.
 */

process.env.CIO_SITE_ID ||= 'test';
process.env.CIO_TRACK_KEY ||= 'test';
process.env.CIO_APP_API_BEARER ||= 'test';
process.env.PERPLEXITY_CONNECTOR_TOKEN ||= 'x'.repeat(32);
process.env.ADMIN_REVOKE_TOKEN ||= 'x'.repeat(32);
process.env.N8N_WEBHOOK_SECRET ||= 'x'.repeat(32);
process.env.BLOB_BACKEND = 's3';
process.env.OPENSEARCH_REGION ||= 'us-east-1';
process.env.AWS_ACCESS_KEY_ID ||= 'AKIDEXAMPLE';
process.env.AWS_SECRET_ACCESS_KEY ||= 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY';
// Deliberately absent: the whole point of the S3 port is that no Azure credential is needed.
delete process.env.AZURE_COMMONS_STORAGE_ACCOUNT;
delete process.env.AZURE_COMMONS_STORAGE_KEY;

const { defaultHeyGenArtifactStore, heyGenArtifactUri, validateHeyGenArtifactRelativePath } =
  await import('./artifact-store.js');

async function capture<T>(
  handler: (url: string, init: RequestInit | undefined) => Response,
  run: () => Promise<T>,
): Promise<{ result?: T; error?: unknown; calls: Array<{ url: string; init: RequestInit | undefined }> }> {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (u: string | URL | Request, init?: RequestInit) => {
    const url = String(u);
    calls.push({ url, init });
    return handler(url, init);
  }) as unknown as typeof fetch;
  try {
    const result = await run();
    return { result, calls };
  } catch (error) {
    return { error, calls };
  } finally {
    globalThis.fetch = original;
  }
}

test('configured() is true under BLOB_BACKEND=s3 with NO Azure credential present at all', () => {
  // The whole point of the port: pruning AZURE_COMMONS_STORAGE_KEY from the task def must not
  // silently kill HeyGen artifact persistence once BLOB_BACKEND=s3 is routing around it anyway.
  assert.equal(process.env.AZURE_COMMONS_STORAGE_KEY, undefined, 'this test is only meaningful with the key absent');
  assert.equal(defaultHeyGenArtifactStore.configured(), true);
});

test('heyGenArtifactUri returns an s3:// URI under BLOB_BACKEND=s3, not azure://', () => {
  assert.equal(
    heyGenArtifactUri('unused-under-s3', 'op_123/v_1/video.mp4'),
    's3://otchealthcommons/heygen-artifacts/_ARTIFACTS/heygen/op_123/v_1/video.mp4',
  );
});

test('put() writes to the commons DR bucket via S3, never to Azure', async () => {
  const { result, error, calls } = await capture(
    () => new Response('', { status: 200, headers: { etag: '"e"' } }),
    () => defaultHeyGenArtifactStore.put('op_1/v_1/manifest.json', new TextEncoder().encode('{}'), 'application/json'),
  );
  assert.equal(error, undefined);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init?.method, 'PUT');
  assert.ok(calls[0].url.startsWith('https://otchealth-brain-dr-55c84f6b.s3.'), calls[0].url);
  assert.ok(calls[0].url.endsWith('/_ARTIFACTS/heygen/op_1/v_1/manifest.json'), calls[0].url);
  assert.equal(calls.some((c) => c.url.includes('blob.core.windows.net')), false, 'no Azure call');
  assert.equal(result?.artifactUri, 's3://otchealthcommons/heygen-artifacts/_ARTIFACTS/heygen/op_1/v_1/manifest.json');
  assert.equal(result?.blobPath, '_ARTIFACTS/heygen/op_1/v_1/manifest.json');
});

test('put() overwrites unconditionally (no If-None-Match), matching the prior Azure behaviour exactly', async () => {
  // The Azure PUT this replaces never sent a conditional header, so every write always overwrote.
  // A regression here would 412 a legitimate manifest-retry write for the same operation+video.
  const { calls } = await capture(
    () => new Response('', { status: 200, headers: { etag: '"e"' } }),
    () => defaultHeyGenArtifactStore.put('op_1/v_1/manifest.json', new TextEncoder().encode('{}'), 'application/json'),
  );
  const headerNames = Object.keys((calls[0].init?.headers as Record<string, string>) ?? {}).map((h) => h.toLowerCase());
  assert.equal(headerNames.includes('if-none-match'), false);
});

test('a second write to the SAME manifest path succeeds (retry-safe, not a 412)', async () => {
  const { error, calls } = await capture(
    () => new Response('', { status: 200, headers: { etag: '"e"' } }),
    async () => {
      await defaultHeyGenArtifactStore.put('op_2/v_2/manifest.json', new TextEncoder().encode('{"a":1}'), 'application/json');
      return defaultHeyGenArtifactStore.put('op_2/v_2/manifest.json', new TextEncoder().encode('{"a":2}'), 'application/json');
    },
  );
  assert.equal(error, undefined);
  assert.equal(calls.length, 2);
});

test('validateHeyGenArtifactRelativePath is unaffected by the backend switch (pure, no env access)', () => {
  assert.equal(validateHeyGenArtifactRelativePath('op_123/v_1/video.mp4'), 'op_123/v_1/video.mp4');
  for (const invalid of ['../escape', '/absolute', 'trailing/', 'bad?query', '']) {
    assert.throws(() => validateHeyGenArtifactRelativePath(invalid));
  }
});
