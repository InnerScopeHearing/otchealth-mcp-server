/**
 * Agent-name normalization for the agent state plane.
 *
 * Normalization validates an identifier's shape; it does not grant access to any lane. The
 * earlier statement that the personal-legal privilege wall was suspended fleet-wide was retracted
 * on 2026-07-29. Callers must enforce the applicable current role and personal-legal boundaries
 * at each read/write operation; this generic helper intentionally does not encode a role policy.
 */

const FORBIDDEN_AGENTS = new Set<string>([]);

export function normalizeAgent(agent: string): string {
  const a = (agent || '').trim().toLowerCase();
  if (!a) throw new Error('agent is required');
  if (FORBIDDEN_AGENTS.has(a)) {
    throw new Error(`agent "${a}" is privilege-walled and not accessible over the gateway`);
  }
  if (!/^[a-z0-9][a-z0-9_-]{0,40}$/.test(a)) {
    throw new Error(`invalid agent "${a}" (expected lowercase id, e.g. cto, cfo, developer)`);
  }
  return a;
}

export const TASK_STATUSES = ['open', 'claimed', 'in_progress', 'blocked', 'done', 'cancelled', 'dead_letter'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

// 'episode' added 2026-07 (Phase 2 capture plane): a best-effort, auto-journaled record of a
// mutating tool call (safety/journal.ts) or an explicit checkpoint marker (tools/memory/checkpoint.ts).
// It is a first-class Cosmos memory KIND like any other -- writable via memory_write, filterable via
// memory_search -- but it is OPERATIONAL EXHAUST for knowledge retrieval: memory/room-hygiene.ts
// already lists 'episode' in EXHAUST_RECORD_TYPES, so brain_search/kb_search deprioritize it by
// default (2026-07-21: demoted, not dropped, so it can still surface if nothing else scores as
// well; full inclusion at native rank with include_ops=true). Do not add it to any "durable
// knowledge" allowlist.
export const MEMORY_KINDS = ['fact', 'decision', 'correction', 'pitfall', 'status', 'episode'] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];
