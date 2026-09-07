import test from 'node:test';
import assert from 'node:assert/strict';
import { S3ObjectAlreadyExistsError } from '../legal/s3-blob-store.js';
import { requireRelationshipPilotAuthority } from './authority.js';
import { materializeRelationships } from './materialize.js';
import { buildFixtureEvent } from './operations.js';
import { rebuildRelationshipProjection } from './projection.js';
import { ingestSyntheticFixture, querySyntheticRelationships } from './service.js';
import { writeRelationshipEvent, type RelationshipObjectStore } from './store.js';
import { canonicalJson, parseRelationshipEvent, sha256 } from './schema.js';
import { CTO_SHIP_LANE_TOOLSET } from '../tools/registry.js';
import { requiredRoleFor } from '../catalog/governance.js';

class MemoryObjectStore implements RelationshipObjectStore {
  readonly objects: Map<string, string>;
  readonly calls: Array<{ op: string; path: string }> = [];
  constructor(objects: Map<string, string> = new Map()) { this.objects = objects; }
  async list(prefix: string) {
    this.calls.push({ op: 'list', path: prefix });
    return [...this.objects.keys()].filter((name) => name.startsWith(prefix)).sort().map((name) => ({ name }));
  }
  async get(path: string) {
    this.calls.push({ op: 'get', path });
    return this.objects.get(path) ?? null;
  }
  async putIfAbsent(path: string, body: string) {
    this.calls.push({ op: 'put', path });
    if (this.objects.has(path)) throw new S3ObjectAlreadyExistsError(412, 'company-journal', path);
    this.objects.set(path, body);
  }
}
function ctx(callerAgent = 'cto', dryRun = false) {
  return { callerAgent, dryRun, correlationId: 'test', callerHash: 'hash', acknowledgeWarning: false };
}
function deps(store: MemoryObjectStore, times: string[]) {
  let i = 0;
  return { store, now: () => new Date(times[Math.min(i++, times.length - 1)]!) };
}
async function ingest(store: MemoryObjectStore, fixtureId: Parameters<typeof ingestSyntheticFixture>[0]['fixtureId'], key: string, time: string) {
  return await ingestSyntheticFixture({ fixtureId, idempotencyKey: key }, ctx(), deps(store, [time]));
}

test('pilot defaults off and denies every non-cto lane before storage access', async () => {
  const store = new MemoryObjectStore();
  delete process.env.RELATIONSHIP_PILOT_MODE;
  await assert.rejects(() => ingestSyntheticFixture({ fixtureId: 'alpha_depends_beta', idempotencyKey: 'disabled-001' }, ctx(), deps(store, ['2026-01-02T00:00:00Z'])), /disabled/);
  process.env.RELATIONSHIP_PILOT_MODE = 'synthetic';
  for (const lane of ['developer', 'exec', 'cfo', 'clo', '']) {
    await assert.rejects(() => ingestSyntheticFixture({ fixtureId: 'alpha_depends_beta', idempotencyKey: `denied-${lane || 'empty'}-001` }, ctx(lane), deps(store, ['2026-01-02T00:00:00Z'])), /authenticated cto lane/);
  }
  assert.equal(store.calls.length, 0);
});

test('dry run performs no S3 writes', async () => {
  process.env.RELATIONSHIP_PILOT_MODE = 'synthetic';
  const store = new MemoryObjectStore();
  const result = await ingestSyntheticFixture({ fixtureId: 'alpha_depends_beta', idempotencyKey: 'dry-run-001' }, ctx('cto', true), deps(store, ['2026-01-02T00:00:00Z']));
  assert.equal(result.persisted, false);
  assert.equal(store.calls.filter((call) => call.op === 'put').length, 0);
});

test('retry-stable event id returns original transaction time and altered intent conflicts', async () => {
  process.env.RELATIONSHIP_PILOT_MODE = 'synthetic';
  const store = new MemoryObjectStore();
  const first = await ingest(store, 'alpha_depends_beta', 'stable-key-001', '2026-01-02T00:00:00Z');
  const retry = await ingest(store, 'alpha_depends_beta', 'stable-key-001', '2026-03-02T00:00:00Z');
  assert.equal(retry.replayed, true);
  assert.equal(retry.event_id, first.event_id);
  assert.equal(retry.recorded_at, '2026-01-02T00:00:00.000Z');
  await assert.rejects(() => ingest(store, 'beta_depends_gamma', 'stable-key-001', '2026-03-03T00:00:00Z'), /idempotency key collision/);
  assert.equal([...store.objects.keys()].filter((key) => key.includes('/events/')).length, 1);
});

test('two-clock correction preserves January truth and changes current truth', async () => {
  process.env.RELATIONSHIP_PILOT_MODE = 'synthetic';
  const store = new MemoryObjectStore();
  await ingest(store, 'alpha_depends_beta', 'history-old-001', '2026-01-02T00:00:00Z');
  await ingest(store, 'alpha_depends_zeta_correction', 'history-new-001', '2026-02-10T00:00:00Z');
  const january = await querySyntheticRelationships({
    entityId: 'synthetic_service_alpha', hops: 1, asOfValid: '2026-01-20T00:00:00Z', asOfTransaction: '2026-03-01T00:00:00Z',
  }, ctx(), deps(store, ['2026-03-01T00:00:00Z']));
  assert.deepEqual(january.edges.map((edge) => edge.object), ['synthetic_service_beta']);
  const current = await querySyntheticRelationships({
    entityId: 'synthetic_service_alpha', hops: 1, asOfValid: '2026-03-01T00:00:00Z', asOfTransaction: '2026-03-01T00:00:00Z',
  }, ctx(), deps(store, ['2026-03-01T00:00:00Z']));
  assert.deepEqual(current.edges.map((edge) => edge.object), ['synthetic_service_zeta']);
  const beforeKnowledge = await querySyntheticRelationships({
    entityId: 'synthetic_service_alpha', hops: 1, asOfValid: '2026-03-01T00:00:00Z', asOfTransaction: '2026-01-20T00:00:00Z',
  }, ctx(), deps(store, ['2026-03-01T00:00:00Z']));
  assert.deepEqual(beforeKnowledge.edges.map((edge) => edge.object), ['synthetic_service_beta']);
});

test('candidate is hidden by default and two-hop traversal is bounded', async () => {
  process.env.RELATIONSHIP_PILOT_MODE = 'synthetic';
  const store = new MemoryObjectStore();
  await ingest(store, 'alpha_depends_beta', 'graph-alpha-001', '2026-01-02T00:00:00Z');
  await ingest(store, 'beta_depends_gamma', 'graph-beta-001', '2026-01-03T00:00:00Z');
  await ingest(store, 'alpha_candidate_delta', 'graph-candidate-001', '2026-01-04T00:00:00Z');
  const result = await querySyntheticRelationships({
    entityId: 'synthetic_service_alpha', hops: 2, asOfValid: '2026-01-10T00:00:00Z', asOfTransaction: '2026-01-10T00:00:00Z',
  }, ctx(), deps(store, ['2026-01-10T00:00:00Z']));
  assert.deepEqual(new Set(result.nodes.map((node) => node.entity_id)), new Set(['synthetic_service_alpha', 'synthetic_service_beta', 'synthetic_service_gamma']));
  assert.equal(result.edges.length, 2);
});

test('unauthorized retraction is filtered before effects', () => {
  const authority = requireRelationshipPilotAuthority(ctx(), 'synthetic');
  const base = buildFixtureEvent('alpha_depends_beta', 'auth-base-001', '2026-01-02T00:00:00Z', authority, []);
  assert.equal(base.operation, 'assert');
  const restricted = parseRelationshipEvent({
    schema: 'otc.relationship.pilot.v1',
    operation: 'retract',
    event_id: `rel_evt_${'f'.repeat(64)}`,
    intent_sha256: 'e'.repeat(64),
    fixture_id: 'restricted_test',
    retracts: base.operation === 'assert' ? base.relationship_id : '',
    effective_valid_from: '2026-02-01T00:00:00Z',
    evidence: [{ source_uri: 'synthetic://restricted/test', source_sha256: 'a'.repeat(64), excerpt_sha256: 'b'.repeat(64), locator: { kind: 'json_pointer', value: '/restricted/test' }, ring: 'restricted-synthetic', extractor: { kind: 'deterministic', name: 'relationship-pilot-fixture', version: '1' } }],
    transaction_time: { recorded_at: '2026-02-01T00:00:00Z' },
    auth: { ring: 'restricted-synthetic', owner_agent: 'cto', policy_version: 'relationship-pilot-v1' },
  });
  const active = materializeRelationships([base, restricted], authority, { asOfValid: '2026-03-01T00:00:00Z', asOfTransaction: '2026-03-01T00:00:00Z' });
  assert.equal(active.length, 1);
});

test('manifest is written last and crash recovery after store reload is deterministic', async () => {
  process.env.RELATIONSHIP_PILOT_MODE = 'synthetic';
  const store = new MemoryObjectStore();
  const authority = requireRelationshipPilotAuthority(ctx(), 'synthetic');
  const event = buildFixtureEvent('alpha_depends_beta', 'crash-event-001', '2026-01-02T00:00:00Z', authority, []);
  const eventPath = `_MEMORY/_relationships/pilot-v1/events/${event.event_id}.json`;
  store.objects.set(eventPath, canonicalJson(event));
  await assert.rejects(() => rebuildRelationshipProjection(store, authority, { failAfterProjectionWrites: 1 }), /injected projection crash/);
  assert.equal([...store.objects.keys()].some((key) => key.includes('/manifests/')), false);
  const reloaded = new MemoryObjectStore(new Map(store.objects));
  const rebuilt = await rebuildRelationshipProjection(reloaded, authority);
  const manifestWrites = reloaded.calls.filter((call) => call.op === 'put' && call.path.includes('/manifests/'));
  assert.equal(manifestWrites.length, 1);
  assert.equal(reloaded.calls.filter((call) => call.op === 'put').at(-1)?.path.includes('/manifests/'), true);
  const replay = await rebuildRelationshipProjection(reloaded, authority);
  assert.equal(replay.generation_id, rebuilt.generation_id);
  assert.equal(replay.event_set_sha256, rebuilt.event_set_sha256);
  assert.equal(replay.replayed, true);
});

test('registry advertises all three pilot tools on the ship connector set', () => {
  for (const name of ['relationship_pilot_ingest_fixture', 'relationship_pilot_query', 'relationship_pilot_rebuild']) {
    assert.equal(CTO_SHIP_LANE_TOOLSET.includes(name), true, name);
    assert.deepEqual(requiredRoleFor(name)?.role, 'cto');
  }
});

test('canonical object hashes remain stable after JSON reload', () => {
  const value = { z: 1, a: { y: 2, x: 3 } };
  assert.equal(sha256(canonicalJson(value)), sha256(canonicalJson(JSON.parse(canonicalJson(value)))));
});

test('accepted write with lost response reports UNKNOWN and same-key replay preserves one original event', async () => {
  process.env.RELATIONSHIP_PILOT_MODE = 'synthetic';
  const store = new MemoryObjectStore();
  const originalPut = store.putIfAbsent.bind(store);
  let loseOnce = true;
  store.putIfAbsent = async (path, body) => {
    await originalPut(path, body);
    if (path.includes('/events/') && loseOnce) {
      loseOnce = false;
      throw new Error('synthetic transport response lost');
    }
  };
  const uncertain = await ingest(store, 'alpha_depends_beta', 'lost-response-001', '2026-01-02T00:00:00Z');
  assert.equal(uncertain.persisted, null);
  assert.equal(uncertain.projected, false);
  assert.equal('durability' in uncertain ? uncertain.durability : undefined, 'UNKNOWN');
  const replay = await ingest(store, 'alpha_depends_beta', 'lost-response-001', '2026-03-02T00:00:00Z');
  assert.equal(replay.persisted, true);
  assert.equal(replay.replayed, true);
  assert.equal(replay.recorded_at, '2026-01-02T00:00:00.000Z');
  assert.equal([...store.objects.keys()].filter((key) => key.includes('/events/')).length, 1);
});

test('replay refuses stored permission or semantic tampering even with copied intent identifiers', async () => {
  const authority = requireRelationshipPilotAuthority(ctx(), 'synthetic');
  const original = buildFixtureEvent('alpha_depends_beta', 'integrity-key-001', '2026-01-02T00:00:00Z', authority, []);
  const later = buildFixtureEvent('alpha_depends_beta', 'integrity-key-001', '2026-03-02T00:00:00Z', authority, []);
  const path = `_MEMORY/_relationships/pilot-v1/events/${original.event_id}.json`;
  const restricted = structuredClone(original);
  restricted.auth.ring = 'restricted-synthetic';
  const store = new MemoryObjectStore(new Map([[path, canonicalJson(restricted)]]));
  await assert.rejects(() => writeRelationshipEvent(store, authority, later), /outside server-selected authority/);
  const changed = structuredClone(original);
  if (changed.operation === 'assert') changed.object.entity_id = 'synthetic_other_entity';
  store.objects.set(path, canonicalJson(changed));
  await assert.rejects(() => writeRelationshipEvent(store, authority, later), /immutable operation intent/);
});

test('a full pilot refuses a new key before writing but permits an existing key replay', async () => {
  process.env.RELATIONSHIP_PILOT_MODE = 'synthetic';
  const authority = requireRelationshipPilotAuthority(ctx(), 'synthetic');
  const store = new MemoryObjectStore();
  for (let i = 0; i < 100; i += 1) {
    const event = buildFixtureEvent('alpha_depends_beta', `capacity-key-${i}`, '2026-01-02T00:00:00Z', authority, []);
    store.objects.set(`_MEMORY/_relationships/pilot-v1/events/${event.event_id}.json`, canonicalJson(event));
  }
  await assert.rejects(() => ingest(store, 'alpha_depends_beta', 'capacity-key-overflow', '2026-03-02T00:00:00Z'), /cap reached/);
  assert.equal(store.calls.filter((call) => call.op === 'put').length, 0);
  const replay = await ingest(store, 'alpha_depends_beta', 'capacity-key-0', '2026-03-02T00:00:00Z');
  assert.equal(replay.replayed, true);
  assert.equal(replay.persisted, true);
});
