/** Durable, metadata-only cursor and execution lease for the historical repair CLI. */
import { createDoc, readDoc, replaceDoc } from '../agentstate/store.js';
import type { HistoricalRepairCheckpoint } from './opensearch-backfill.js';

const CHECKPOINT_SCOPE = 'memory-index-repair-v1';
const SOURCE_ID = /^[A-Za-z0-9_.\-]{1,255}$/;
const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const HISTORICAL_REPAIR_LEASE_MS = 2 * 60 * 60 * 1000;

export type HistoricalRepairCheckpointLoad = Readonly<{
  exists: boolean;
  checkpoint?: HistoricalRepairCheckpoint;
  lease_active?: boolean;
}>;

export type HistoricalRepairLease = Readonly<{
  acquired: true;
  agent: string;
  index: string;
  run_id: string;
  etag: string;
  checkpoint?: HistoricalRepairCheckpoint;
  previous_checkpoint?: HistoricalRepairCheckpoint;
  previous_completed_run_id: string | null;
}>;

export interface HistoricalRepairCheckpointStore {
  load(agent: string, index: string): Promise<HistoricalRepairCheckpointLoad>;
  acquire(agent: string, index: string, runId: string): Promise<HistoricalRepairLease | { acquired: false }>;
  commit(lease: HistoricalRepairLease, checkpoint: HistoricalRepairCheckpoint): Promise<boolean>;
  release(lease: HistoricalRepairLease): Promise<boolean>;
}

type StoreResponse = Readonly<{ ok: boolean; etag?: string | null }>;
type HistoricalRepairCheckpointDeps = Readonly<{
  readDoc: (collection: string, partition: string, id: string) => Promise<{ doc: Record<string, unknown>; etag: string | null } | null>;
  createDoc: (collection: string, partition: string, doc: Record<string, unknown>) => Promise<StoreResponse>;
  replaceDoc: (collection: string, partition: string, id: string, doc: Record<string, unknown>, etag?: string) => Promise<StoreResponse>;
  now: () => number;
}>;

type LeaseDoc = Readonly<{ run_id: string; acquired_at: string; expires_at: string }>;
type Stored = Readonly<{
  etag: string;
  checkpoint?: HistoricalRepairCheckpoint;
  lease: LeaseDoc | null;
  last_completed_run_id: string | null;
}>;

const DEFAULT_DEPS: HistoricalRepairCheckpointDeps = { readDoc, createDoc, replaceDoc, now: Date.now };

export function normalizeHistoricalRepairCheckpoint(value: unknown, agent: string): HistoricalRepairCheckpoint {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('checkpoint_invalid');
  const checkpoint = value as Record<string, unknown>;
  if (
    Object.keys(checkpoint).sort().join(',') !== 'after_id,agent,pending_ids,version' ||
    checkpoint.version !== 'memory-index-repair-v1' || checkpoint.agent !== agent ||
    typeof checkpoint.after_id !== 'string' || !SOURCE_ID.test(checkpoint.after_id || 'x') ||
    !Array.isArray(checkpoint.pending_ids) ||
    checkpoint.pending_ids.some(id => typeof id !== 'string' || !SOURCE_ID.test(id))
  ) throw new Error('checkpoint_invalid');
  return { version: 'memory-index-repair-v1', agent, after_id: checkpoint.after_id, pending_ids: [...new Set(checkpoint.pending_ids as string[])].sort() };
}

export function historicalRepairCheckpointId(agent: string, index: string): string {
  const id = `checkpoint.${agent}.${index}`;
  if (!SOURCE_ID.test(id)) throw new Error('checkpoint_key_invalid');
  return id;
}

function normalizeLease(value: unknown): LeaseDoc | null {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('checkpoint_store_invalid');
  const lease = value as Record<string, unknown>;
  if (Object.keys(lease).sort().join(',') !== 'acquired_at,expires_at,run_id' ||
      typeof lease.run_id !== 'string' || !RUN_ID.test(lease.run_id) ||
      typeof lease.acquired_at !== 'string' || !Number.isFinite(Date.parse(lease.acquired_at)) ||
      typeof lease.expires_at !== 'string' || !Number.isFinite(Date.parse(lease.expires_at))) {
    throw new Error('checkpoint_store_invalid');
  }
  return { run_id: lease.run_id, acquired_at: lease.acquired_at, expires_at: lease.expires_at };
}

function document(agent: string, index: string, checkpoint: HistoricalRepairCheckpoint | undefined,
  lease: LeaseDoc | null, completed: string | null, now: number): Record<string, unknown> {
  return {
    id: historicalRepairCheckpointId(agent, index), cacheScope: CHECKPOINT_SCOPE,
    type: 'memory_index_repair_checkpoint', agent, index, checkpoint: checkpoint ?? null,
    lease, last_completed_run_id: completed, updated_at: new Date(now).toISOString(),
    // The cache container has a default TTL. This cursor must survive task and gateway restarts.
    ttl: -1,
  };
}

async function readStored(deps: HistoricalRepairCheckpointDeps, agent: string, index: string): Promise<Stored | null> {
  const hit = await deps.readDoc('cache', CHECKPOINT_SCOPE, historicalRepairCheckpointId(agent, index));
  if (!hit) return null;
  const doc = hit.doc;
  if (doc.type !== 'memory_index_repair_checkpoint' || doc.cacheScope !== CHECKPOINT_SCOPE ||
      doc.agent !== agent || doc.index !== index || doc.ttl !== -1 || !hit.etag ||
      (doc.last_completed_run_id !== null && (typeof doc.last_completed_run_id !== 'string' || !RUN_ID.test(doc.last_completed_run_id)))) {
    throw new Error('checkpoint_store_invalid');
  }
  return {
    etag: hit.etag,
    checkpoint: doc.checkpoint === null ? undefined : normalizeHistoricalRepairCheckpoint(doc.checkpoint, agent),
    lease: normalizeLease(doc.lease),
    last_completed_run_id: doc.last_completed_run_id as string | null,
  };
}

function sameCheckpoint(left: HistoricalRepairCheckpoint | undefined, right: HistoricalRepairCheckpoint): boolean {
  return left !== undefined && JSON.stringify(left) === JSON.stringify(normalizeHistoricalRepairCheckpoint(right, right.agent));
}

export function createHistoricalRepairCheckpointStore(deps: HistoricalRepairCheckpointDeps = DEFAULT_DEPS): HistoricalRepairCheckpointStore {
  return {
    async load(agent, index) {
      const stored = await readStored(deps, agent, index);
      return stored ? { exists: true, checkpoint: stored.checkpoint, lease_active: Boolean(stored.lease && Date.parse(stored.lease.expires_at) > deps.now()) } : { exists: false };
    },

    async acquire(agent, index, runId) {
      if (!RUN_ID.test(runId)) throw new Error('repair_run_id_invalid');
      const now = deps.now();
      const prior = await readStored(deps, agent, index);
      if (prior?.lease && Date.parse(prior.lease.expires_at) > now) return { acquired: false };
      const lease: LeaseDoc = { run_id: runId, acquired_at: new Date(now).toISOString(), expires_at: new Date(now + HISTORICAL_REPAIR_LEASE_MS).toISOString() };
      const next = document(agent, index, prior?.checkpoint, lease, prior?.last_completed_run_id ?? null, now);
      let response: StoreResponse | undefined;
      try {
        response = prior
          ? await deps.replaceDoc('cache', CHECKPOINT_SCOPE, historicalRepairCheckpointId(agent, index), next, prior.etag)
          : await deps.createDoc('cache', CHECKPOINT_SCOPE, next);
      } catch { /* An interrupted response can follow a committed write. Verify below. */ }
      if (response?.ok && response.etag) {
        return { acquired: true, agent, index, run_id: runId, etag: response.etag, checkpoint: prior?.checkpoint, previous_checkpoint: prior?.checkpoint, previous_completed_run_id: prior?.last_completed_run_id ?? null };
      }
      const recovered = await readStored(deps, agent, index);
      if (recovered?.lease?.run_id === runId) {
        return { acquired: true, agent, index, run_id: runId, etag: recovered.etag, checkpoint: recovered.checkpoint, previous_checkpoint: prior?.checkpoint, previous_completed_run_id: prior?.last_completed_run_id ?? null };
      }
      return { acquired: false };
    },

    async commit(lease, checkpoint) {
      const now = deps.now();
      const normalized = normalizeHistoricalRepairCheckpoint(checkpoint, lease.agent);
      const next = document(lease.agent, lease.index, normalized, null, lease.run_id, now);
      try {
        const response = await deps.replaceDoc('cache', CHECKPOINT_SCOPE, historicalRepairCheckpointId(lease.agent, lease.index), next, lease.etag);
        if (response.ok) return true;
      } catch { /* Verify an unknown write outcome before reporting failure. */ }
      const recovered = await readStored(deps, lease.agent, lease.index);
      return recovered?.last_completed_run_id === lease.run_id && sameCheckpoint(recovered.checkpoint, normalized);
    },

    async release(lease) {
      const next = document(lease.agent, lease.index, lease.previous_checkpoint, null, lease.previous_completed_run_id, deps.now());
      try {
        const response = await deps.replaceDoc('cache', CHECKPOINT_SCOPE, historicalRepairCheckpointId(lease.agent, lease.index), next, lease.etag);
        if (response.ok) return true;
      } catch { /* Verify an unknown write outcome. */ }
      const recovered = await readStored(deps, lease.agent, lease.index);
      return Boolean(recovered && recovered.lease === null && recovered.last_completed_run_id === lease.previous_completed_run_id);
    },
  };
}

export const historicalRepairCheckpointStore = createHistoricalRepairCheckpointStore();
