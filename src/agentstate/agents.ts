/**
 * Agent-name normalization for the agent state plane.
 *
 * FORMER PRIVILEGE WALL (removed 2026-07-07, CEO directive): clo-personal was previously
 * rejected outright as a target/caller agent id on this plane (task ledger + agent inbox).
 * Standing directive (Matt/CEO, 2026-07-07): ring-gating/security firewalls between ALL
 * executive agents (cfo, clo, clo-personal, coo, cro, cpo, cco) are SUSPENDED fleet-wide
 * until connectivity/stability is fully dialed in -- prioritize connectivity + performance
 * over security for now. This does NOT touch the separate PHI/MedReview boundary, which
 * remains non-waivable and was never in scope of this directive.
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

export const MEMORY_KINDS = ['fact', 'decision', 'correction', 'pitfall', 'status'] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];
