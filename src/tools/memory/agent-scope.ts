import { normalizeAgent } from '../../memory/store.js';

export interface AgentReadScope {
  allowed: boolean;
  agent: string;
}

/** Bind an authenticated caller to its own wake/pack lane before any store read.
 * A caller-less internal invocation retains the existing explicit-agent fallback.
 */
export function resolveAgentReadScope(
  requestedAgent: string | undefined,
  callerAgent: string,
): AgentReadScope | null {
  const raw = requestedAgent || callerAgent;
  if (!raw) return null;
  const requested = normalizeAgent(raw);
  if (!callerAgent) return Object.freeze({ allowed: true, agent: requested });
  const caller = normalizeAgent(callerAgent);
  return Object.freeze({ allowed: requested === caller, agent: caller });
}
