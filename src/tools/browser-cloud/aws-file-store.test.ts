import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createAwsBrowserFileStore } from './aws-file-store.js';
import type { BrowserFileRecord } from './file-broker.js';

const owner = 'cto';
const id = '123e4567-e89b-42d3-a456-426614174000';
const body = Buffer.from('safe staged bytes');
const sha256 = createHash('sha256').update(body).digest('hex');
const record: BrowserFileRecord = { id, owner, filename: 'notes.txt', contentType: 'text/plain', byteLength: body.length, sha256, status: 'ready', expiresAt: 2_000_000 };
const credentials = async () => ({ accessKeyId: 'test-access', secretAccessKey: 'test-secret' });

function harness(getBody: Uint8Array = body) {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  let item: Record<string, any> | undefined;
  const store = createAwsBrowserFileStore({ table: 'browser-files-test', bucket: 'otchealth-chat-agents-900915535335-us-east-1', region: 'us-east-1' }, {
    credentials,
    now: () => 1_000_000,
    fetch: async (url, init = {}) => {
      const target = new Request(url, init);
      requests.push({ url: String(url), init });
      if (target.headers.get('x-amz-target')?.endsWith('.PutItem')) {
        const payload = JSON.parse(String(init.body));
        item = payload.Item;
        return new Response('{}');
      }
      if (target.headers.get('x-amz-target')?.endsWith('.GetItem')) return new Response(JSON.stringify({ Item: item }));
      if (target.method === 'PUT') return new Response('', { status: 200, headers: { 'x-amz-version-id': 'object-v1' } });
      if (target.method === 'GET') return new Response(getBody, { status: 200, headers: { 'x-amz-version-id': 'object-v1', 'content-length': String(getBody.byteLength), 'content-type': record.contentType } });
      throw new Error('unexpected test request');
    },
  });
  return { store, requests, getItem: () => item };
}

test('file store writes immutable owner-derived S3 key and create-only DDB metadata', async () => {
  const h = harness();
  await h.store.put(`browser-files/${owner}/${id}`, record, body);
  const put = h.requests.find((request) => new Request(request.url, request.init).method === 'PUT')!;
  assert.match(put.url, /\/browser-cloud\/files\/cto\/123e4567-e89b-42d3-a456-426614174000$/);
  const putRequest = new Request(put.url, put.init);
  assert.equal(putRequest.headers.get('if-none-match'), '*');
  assert.equal(putRequest.headers.get('x-amz-server-side-encryption'), 'AES256');
  assert.equal(putRequest.headers.get('content-type'), 'text/plain');
  const item = h.getItem()!;
  assert.deepEqual(item.pk, { S: `FILE#${owner}#${id}` });
  assert.equal(item.storageKey.S, `browser-cloud/files/${owner}/${id}`);
  assert.equal(item.storageVersion.S, 'object-v1');
  assert.equal(item.sha256.S, sha256);
  assert.equal(item.expiresAtEpoch.N, '2000');
  const ddbPut = h.requests.find((request) => new Request(request.url, request.init).headers.get('x-amz-target')?.endsWith('.PutItem'))!;
  assert.equal(JSON.parse(String(ddbPut.init.body)).ConditionExpression, 'attribute_not_exists(pk)');
});

test('file store reads exact owner key and version, then verifies bytes and metadata', async () => {
  const h = harness();
  await h.store.put(`browser-files/${owner}/${id}`, record, body);
  h.requests.length = 0;
  const stored = await h.store.get(`browser-files/${owner}/${id}`);
  assert.deepEqual(stored?.record, record);
  assert.deepEqual(Buffer.from(stored!.body), body);
  const get = h.requests.find((request) => new Request(request.url, request.init).method === 'GET')!;
  assert.match(get.url, /\/browser-cloud\/files\/cto\/123e4567-e89b-42d3-a456-426614174000\?versionId=object-v1$/);
  const ddbGet = h.requests.find((request) => new Request(request.url, request.init).headers.get('x-amz-target')?.endsWith('.GetItem'))!;
  assert.equal(JSON.parse(String(ddbGet.init.body)).ConsistentRead, true);
});

test('file store rejects foreign keys, oversized bytes, and returned integrity mismatches', async () => {
  const h = harness(Buffer.from('different bytes'));
  await assert.rejects(h.store.put(`browser-files/other/${id}`, record, body), /invalid/i);
  await assert.rejects(h.store.put(`browser-files/${owner}/${id}`, record, new Uint8Array(10 * 1024 * 1024 + 1)), /invalid/i);
  await h.store.put(`browser-files/${owner}/${id}`, record, body);
  await assert.rejects(h.store.get(`browser-files/${owner}/${id}`), /integrity/i);
});
