import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleTaskAcknowledge, type TaskAcknowledgeInput, type TaskAcknowledgeDependencies } from './task-acknowledge.js';
import type { Task } from '../../agentstate/ledger.js';
import type { ToolContext } from '../registry.js';

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 't_existing', board: 'fleet', type: 'task', title: 'Existing task', description: 'Existing criteria',
    owner_agent: 'cto', status: 'in_progress', priority: 'high', tags: ['coordination'], artifact_uri: null,
    created_by: 'cto', detail_readers: ['cto', 'developer'], created_at: '2026-10-01T00:00:00.000Z',
    updated_at: '2026-10-04T23:00:00.000Z', claim_ts: '2026-10-04T23:00:00.000Z',
    lease_until: '2026-10-05T00:00:00.000Z', lease_version: 4, idempotency_key: null,
    done_ts: null, notes: [], attempt_count: 0, ...overrides,
  };
}

function ctx(callerAgent = 'cto'): ToolContext {
  return { correlationId: 'corr-runtime-1', callerHash: 'credential-sha256', dryRun: false, acknowledgeWarning: false, callerAgent };
}

function input(overrides: Partial<TaskAcknowledgeInput> = {}): TaskAcknowledgeInput {
  return {
    task_id: 't_existing', board: 'fleet', expected_lease_version: 4, acknowledgement_key: 'ack-key-0001',
    receiver_handle_kind: 'codex_thread', receiver_declared_handle: 'session-declared-by-receiver',
    evidence_sha256: 'a'.repeat(64), ...overrides,
  };
}

function fixture(current = task()) {
  const documents = new Map<string, Record<string, unknown>>();
  let writes = 0;
  const deps: TaskAcknowledgeDependencies = {
    isConfigured: () => true,
    getTask: async () => current,
    createDoc: async (collection, partition, doc) => {
      assert.equal(collection, 'events');
      assert.equal(partition, 't_existing');
      const id = String(doc.id);
      if (documents.has(id)) throw new Error('duplicate id');
      documents.set(id, structuredClone(doc));
      writes += 1;
      return { status: 201, ok: true, body: doc, etag: 'etag' } as never;
    },
    readDoc: async (_collection, _partition, id) => {
      const doc = documents.get(id);
      return doc ? { doc: structuredClone(doc), etag: 'etag' } : null;
    },
    taskVisibleToCaller: (t, lane) => t.owner_agent === lane || (t.detail_readers ?? []).includes(String(lane)),
    canReadTaskDetails: (t, lane) => t.owner_agent === lane || (t.detail_readers ?? []).includes(String(lane)),
    now: () => new Date('2026-10-04T23:30:00.000Z'),
  };
  return { deps, documents, writes: () => writes };
}

test('records a durable exact-lease acknowledgement with declared and runtime-attested fields separated', async () => {
  const current = task();
  const before = structuredClone(current);
  const f = fixture(current);
  const result = await handleTaskAcknowledge(input(), ctx('cto'), f.deps);
  const data = result.data as any;
  assert.equal(data.acknowledged, true);
  assert.equal(data.readback_confirmed, true);
  assert.equal(data.lease_current_at_readback, true);
  assert.equal(data.record.actor, 'cto');
  assert.equal(data.record.task_snapshot.lease_version, 4);
  assert.equal(data.record.receiver_declared.handle, 'session-declared-by-receiver');
  assert.equal(data.record.receiver_declared.handle_verification, 'caller_declared_not_runtime_attested');
  assert.equal(data.record.receiver_declared.evidence_sha256, 'a'.repeat(64));
  assert.equal(data.record.receiver_declared.evidence_verification, 'caller_declared_digest_not_content_verified');
  assert.equal(data.record.runtime_attested.authenticated_lane, 'cto');
  assert.equal(data.record.runtime_attested.request_correlation_id, 'corr-runtime-1');
  assert.deepEqual(data.record.claims, { session_identity_verified: false, device_execution_proven: false, inbox_consumption_proven: false });
  assert.deepEqual(task(), before, 'acknowledgement does not mutate or renew the task lease');
  assert.equal(f.writes(), 1);
  assert.ok(f.documents.has(data.record.id), 'event collection contains the exact record independently of the result');
});

test('authenticated caller lane, not receiver declaration, controls task acknowledgement attribution', async () => {
  const f = fixture(task({ detail_readers: ['cto', 'coo'] }));
  const result = await handleTaskAcknowledge(input({ receiver_declared_handle: 'developer-claims-cto-session' }), ctx('coo'), f.deps);
  const data = result.data as any;
  assert.equal(data.acknowledged, false);
  assert.match(data.reason, /authenticated current task owner lane/);
  assert.equal(f.writes(), 0);
});

test('personal-task visibility forbids acknowledgement by an unauthorized lane', async () => {
  const personal = task({ id: 't_personal', owner_agent: 'clo-personal', created_by: 'clo-personal', detail_readers: ['clo-personal'] });
  const f = fixture(personal);
  const result = await handleTaskAcknowledge(input({ task_id: 't_personal' }), ctx('cto'), f.deps);
  assert.deepEqual(result.data, { acknowledged: false, reason: 'task not found or unavailable to this lane' });
  assert.equal(f.writes(), 0);
});

test('stale lease version is refused before any acknowledgement is written', async () => {
  const f = fixture();
  const result = await handleTaskAcknowledge(input({ expected_lease_version: 3 }), ctx(), f.deps);
  assert.deepEqual(result.data, { acknowledged: false, reason: 'stale lease version' });
  assert.equal(f.writes(), 0);
});

test('same idempotency key and same digest reads back the original; changed digest conflicts', async () => {
  const f = fixture();
  const first = await handleTaskAcknowledge(input(), ctx(), f.deps);
  const replay = await handleTaskAcknowledge(input(), ctx(), f.deps);
  const changed = await handleTaskAcknowledge(input({ evidence_sha256: 'b'.repeat(64) }), ctx(), f.deps);
  assert.equal((first.data as any).acknowledged, true);
  assert.equal((replay.data as any).replayed, true);
  assert.equal((replay.data as any).readback_confirmed, true);
  assert.deepEqual((replay.data as any).record, (first.data as any).record);
  assert.deepEqual(changed.data, { acknowledged: false, reason: 'idempotency key was already used with different acknowledgement content' });
  assert.equal(f.writes(), 1);
});

test('exact historical retry is readable but reports that its lease has since been replaced', async () => {
  const current = task();
  const f = fixture(current);
  await handleTaskAcknowledge(input(), ctx(), f.deps);
  Object.assign(current, { lease_version: 5, lease_until: '2026-10-05T01:00:00.000Z' });
  const replay = await handleTaskAcknowledge(input(), ctx(), f.deps);
  assert.equal((replay.data as any).acknowledged, true, 'the historical acknowledgement remains durable');
  assert.equal((replay.data as any).lease_current_at_readback, false, 'a replaced lease cannot be mistaken for the current lease');
  assert.equal((replay.data as any).record.task_snapshot.lease_version, 4);
  assert.equal(f.writes(), 1);
});

test('historical retry does not expose an event after ownership and detail access are revoked', async () => {
  const current = task();
  const f = fixture(current);
  await handleTaskAcknowledge(input(), ctx(), f.deps);
  Object.assign(current, { owner_agent: 'developer', detail_readers: ['developer'] });
  const replay = await handleTaskAcknowledge(input(), ctx(), f.deps);
  assert.deepEqual(replay.data, { acknowledged: false, reason: 'task not found or unavailable to this lane' });
  assert.equal(f.writes(), 1);
});

test('stale, inactive, or unleased tasks cannot be acknowledged', async () => {
  const noLease = task({ status: 'open', lease_until: null });
  const f = fixture(noLease);
  const result = await handleTaskAcknowledge(input(), ctx(), f.deps);
  assert.deepEqual(result.data, { acknowledged: false, reason: 'task must have an active claimed or in-progress lease' });
  assert.equal(f.writes(), 0);
});
