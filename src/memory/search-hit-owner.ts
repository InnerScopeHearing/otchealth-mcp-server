import { agentFromDocId } from './auto-supersede-runtime.js';

/** Preserve the indexed owner for legacy bare IDs. A personal-lane indication from either
 * source wins a conflict so a company caller cannot receive a mislabeled protected hit. */
export function memorySearchHitOwner(id: unknown, sourceAgent: unknown): string {
  const prefix = agentFromDocId(id).trim().toLowerCase();
  const source = typeof sourceAgent === 'string' ? sourceAgent.trim().toLowerCase() : '';
  if (prefix === 'clo-personal' || source === 'clo-personal') return 'clo-personal';
  return prefix || source;
}
