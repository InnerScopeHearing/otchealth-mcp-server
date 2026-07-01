/**
 * Agent-name normalization + the privilege wall for the agent state plane.
 * The clo-personal lane is attorney-privileged and never crosses the gateway.
 */

const FORBIDDEN_AGENTS = new Set(['clo-personal']);

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

export const TASK_STATUSES = ['open', 'claimed', 'in_progress', 'blocked', 'done', 'cancelled'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const MEMORY_KINDS = ['fact', 'decision', 'correction', 'pitfall', 'status'] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];
