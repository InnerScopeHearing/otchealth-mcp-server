import assert from 'node:assert/strict';
import test from 'node:test';
import { createDynamoBrowserJobStore, createS3BrowserArtifactStore, createSqsBrowserQueue } from './aws-adapters.js';

const credentials = async () => ({ accessKeyId: 'AKID', secretAccessKey: 'secret' });
test('S3 adapter requires immutable browser-cloud prefix and captures version', async () => {
  let request: Request | undefined; const store = createS3BrowserArtifactStore({}, { credentials, fetch: async (url, init) => { request = new Request(url, init); return new Response('', { status: 200, headers: { 'x-amz-version-id': 'v1' } }); } }); const body = Buffer.from('receipt'); const sha = '6f32860910ca0fb2a20c7fda143666b09dbf8db5238195c90a586fb542ff0cad';
  const result = await store.putImmutable({ key: 'browser-cloud/cto/job/artifact', body, contentType: 'text/plain', sha256: sha }); assert.equal(result.version, 'v1'); assert.equal(request?.headers.get('if-none-match'), '*'); assert.equal(request?.headers.get('x-amz-server-side-encryption'), 'AES256');
});
test('SQS adapter emits FIFO ownership group and job deduplication only for FIFO queues', async () => {
  let body = ''; const queue = createSqsBrowserQueue({ queueUrl: 'https://sqs.us-east-1.amazonaws.com/900915535335/otchealth-browser-cloud.fifo' }, { credentials, fetch: async (_url, init) => { body = String(init?.body); return new Response('', { status: 200 }); } }); await queue.enqueue('bcj_1', 'cto'); assert.match(body, /MessageGroupId=cto/); assert.match(body, /MessageDeduplicationId=bcj_1/);
});
test('SQS standard queue omits FIFO-only fields', async () => {
  let body = ''; const queue = createSqsBrowserQueue({ queueUrl: 'https://sqs.us-east-1.amazonaws.com/900915535335/otchealth-browser-cloud' }, { credentials, fetch: async (_url, init) => { body = String(init?.body); return new Response('', { status: 200 }); } }); await queue.enqueue('bcj_1', 'cto'); assert.doesNotMatch(body, /MessageGroupId|MessageDeduplicationId/);
});
test('SQS receive decodes XML-escaped JSON body', async () => {
  const queue = createSqsBrowserQueue({ queueUrl: 'https://sqs.us-east-1.amazonaws.com/900915535335/otchealth-browser-cloud' }, { credentials, fetch: async () => new Response('<ReceiveMessageResponse><ReceiveMessageResult><Message><MessageId>x</MessageId><ReceiptHandle>a&amp;b</ReceiptHandle><Body>{&quot;jobId&quot;:&quot;j&quot;,&quot;agent&quot;:&quot;cto&quot;}</Body></Message></ReceiveMessageResult></ReceiveMessageResponse>', { status: 200 }) }); assert.deepEqual(await queue.receive(1, 10), [{ id: 'x', receipt: 'a&b', jobId: 'j', agent: 'cto' }]);
});
test('Dynamo replacement is one transaction and non-conditional cancellation propagates', async () => {
  const bodies: unknown[] = []; const store = createDynamoBrowserJobStore({}, { credentials, fetch: async (_url, init) => { const body = JSON.parse(String(init?.body)); bodies.push(body); return new Response(JSON.stringify(body.TransactItems ? { __type: 'com.amazonaws.dynamodb.v20120810#TransactionCanceledException' } : {}), { status: body.TransactItems ? 400 : 200 }); } }); const job = { id: 'bcj_x', agent: 'cto', requestDigest: 'a', idempotencyDigest: 'b', request: {}, status: 'queued', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', leaseOwner: null, leaseUntil: null, leaseToken: 0, attempts: 0, cancellationRequestedAt: null, externalEffect: 'none', actionEffects: {}, dispatchState: 'pending', dispatchAttempts: 0, artifacts: [], errorCode: null } as const; await assert.rejects(store.replace(job, '1'), /TransactionCanceledException/); assert.equal((bodies[0] as { TransactItems: unknown[] }).TransactItems.length, 2);
});
test('Dynamo create treats only conditional transaction cancellation as an idempotency hit', async () => {
  const job = { id: 'bcj_x', agent: 'cto', requestDigest: 'a', idempotencyDigest: 'b', request: {}, status: 'queued', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', leaseOwner: null, leaseUntil: null, leaseToken: 0, attempts: 0, cancellationRequestedAt: null, externalEffect: 'none', actionEffects: {}, dispatchState: 'pending', dispatchAttempts: 0, artifacts: [], errorCode: null } as const; const store = createDynamoBrowserJobStore({}, { credentials, fetch: async () => new Response(JSON.stringify({ __type: 'com.amazonaws.dynamodb.v20120810#TransactionCanceledException', CancellationReasons: [{ Code: 'ConditionalCheckFailed' }, { Code: 'None' }] }), { status: 400 }) }); assert.equal(await store.createIfAbsent(job), 'exists');
});
