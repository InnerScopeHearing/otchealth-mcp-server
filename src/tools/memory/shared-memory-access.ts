import { PERSONAL_LEGAL_RING } from '../kb/search-privileged.js';
import type { MemoryEntry } from '../../memory/store.js';

/** The shared commons feed is not a personal-legal transport.  Historical rows with this
 * lane label must never be returned to a company caller while the private store is repaired. */
export const PERSONAL_SHARED_MEMORY_AGENT = 'clo-personal';

function lane(value: string | undefined | null): string {
  return (value || '').trim().toLowerCase();
}

export function mayReadPersonalSharedMemory(callerAgent: string | undefined | null): boolean {
  return (PERSONAL_LEGAL_RING as readonly string[]).includes(lane(callerAgent));
}

/** Filter at the response boundary too, so a semantic backend cannot widen the ring. */
export function filterPersonalSharedMemory<T extends { agent?: unknown }>(
  entries: readonly T[],
  callerAgent: string | undefined | null,
): T[] {
  if (mayReadPersonalSharedMemory(callerAgent)) return [...entries];
  return entries.filter((entry) => lane(typeof entry.agent === 'string' ? entry.agent : '') !== PERSONAL_SHARED_MEMORY_AGENT);
}

export function sharedMemoryAgentAllowed(callerAgent: string | undefined | null, requestedAgent: string | undefined | null): boolean {
  return lane(requestedAgent) !== PERSONAL_SHARED_MEMORY_AGENT || mayReadPersonalSharedMemory(callerAgent);
}

export type SharedMemoryEntry = MemoryEntry;
