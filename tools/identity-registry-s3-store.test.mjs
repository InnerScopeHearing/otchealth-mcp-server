import assert from 'node:assert/strict';
import { createIdentityRegistryS3SnapshotStore } from './identity-registry-s3-store.mjs';

const objects = new Map();
let revision = 0;
let loseNextSnapshotAck = false;
let loseNextSnapshotBeforeWrite = false;
let badReadEncryption = false;
let badPinnedVersion = false;
let putCount = 0;
const response = (body, status, version, { pinned = false } = {}) => new Response(body, { status, headers: version ? {
  'x-amz-version-id': badPinnedVersion && pinned ? 'synthetic-wrong-version' : version,
  'x-amz-server-side-encryption': badReadEncryption ? 'aws:kms' : 'AES256',
} : {} });
const fetchImpl = async (urlText, init) => {
  const url = new URL(urlText); const key = url.pathname.slice(1); const current = objects.get(key);
  const wanted = url.searchParams.get('versionId');
  if (init.method === 'GET') {
    const item = wanted ? current?.versions.get(wanted) : current?.current;
    return item ? response(item.body, 200, item.version, { pinned: !!wanted }) : response('', 404);
  }
  if (init.method !== 'PUT' || new Headers(init.headers).get('if-none-match') !== '*') return response('', 400);
  if (current?.current) return response('', 412);
  if (loseNextSnapshotBeforeWrite && key.includes('/snapshots/')) { loseNextSnapshotBeforeWrite = false; throw new Error('synthetic_no_write_lost_ack'); }
  const version = `synthetic-v${++revision}`;
  putCount += 1;
  const item = { body: String(init.body), version };
  objects.set(key, { current: item, versions: new Map([[version, item]]) });
  if (loseNextSnapshotAck && key.includes('/snapshots/')) { loseNextSnapshotAck = false; throw new Error('synthetic_lost_ack'); }
  return response('', 200, version);
};
const config = () => ({ bucket: 'synthetic-registry-store', prefix: 'graph-trial/identity-registry', region: 'us-east-1', requestTimeoutMs: 100,
  immutableTombstonePolicyAttested: true, signRequest: async request => ({ url: request.url, headers: request.headers }), fetchImpl, sse: { algorithm: 'AES256' } });
const request = { registry_id: 'cfo-registry', version: 'sirv_synthetic_001', envelope: { schema: 'signed-envelope', payload: { explicit_id: 'synthetic-001' } } };

const first = createIdentityRegistryS3SnapshotStore(config());
assert.equal(await first.publish(request), true, 'conditional snapshot publish is read-back confirmed');
assert.deepEqual(await first.read(request), { status: 'active', envelope: request.envelope }, 'pinned snapshot is readable');
const restarted = createIdentityRegistryS3SnapshotStore(config());
assert.deepEqual(await restarted.read(request), { status: 'active', envelope: request.envelope }, 'fresh replica reads durable receipt and pinned object version');
const concurrentRequest = { ...request, version: 'sirv_synthetic_002' };
const replicaA = createIdentityRegistryS3SnapshotStore(config()), replicaB = createIdentityRegistryS3SnapshotStore(config());
const raced = await Promise.all([replicaA.publish(concurrentRequest), replicaB.publish(concurrentRequest)]);
assert.equal(raced.filter(Boolean).length, 1, 'two replicas have exactly one successful conditional creator');
loseNextSnapshotAck = true;
assert.equal(await createIdentityRegistryS3SnapshotStore(config()).publish({ ...request, version: 'sirv_synthetic_lost_ack' }), true,
  'lost acknowledgement is reconciled from the exact stored object before reporting success');
loseNextSnapshotBeforeWrite = true;
await assert.rejects(() => createIdentityRegistryS3SnapshotStore(config()).publish({ ...request, version: 'sirv_synthetic_unknown' }),
  error => error.code === 'identity_registry_store_write_unknown', 'a lost acknowledgement without an artifact remains unknown');
assert.equal(await restarted.revoke({ registry_id: request.registry_id, version: request.version }), true, 'immutable tombstone is read-back confirmed');
assert.deepEqual(await createIdentityRegistryS3SnapshotStore(config()).read(request), { status: 'revoked' }, 'revocation denies a snapshot after restart');
assert.deepEqual(await restarted.reconcile({ ...concurrentRequest }), { status: 'active' }, 'reconciliation confirms existing exact artifact');
const beforeReadPuts = putCount;
await restarted.read(request);
assert.equal(putCount, beforeReadPuts, 'normal read never writes a tombstone receipt');
badReadEncryption = true;
await assert.rejects(() => createIdentityRegistryS3SnapshotStore(config()).read(concurrentRequest), /identity_registry_store_read_headers_invalid/, 'GET requires configured S3 encryption headers');
badReadEncryption = false; badPinnedVersion = true;
await assert.rejects(() => createIdentityRegistryS3SnapshotStore(config()).read(concurrentRequest), /identity_registry_store_read_headers_invalid/, 'pinned GET requires its exact S3 version');
badPinnedVersion = false;
await assert.rejects(() => createIdentityRegistryS3SnapshotStore({ ...config(), requestTimeoutMs: 1, fetchImpl: async () => new Promise(() => {}) }).publish({ ...request, version: 'sirv_synthetic_timeout' }),
  error => error.code === 'identity_registry_store_deadline', 'ignored transport callback is deadline bounded');
process.stdout.write(JSON.stringify({ store: 'identity-registry-s3', restart: true, conditional_replicas: true, lost_ack_reconciled: true, revocation: true, real_aws_calls: 0 }) + '\n');
