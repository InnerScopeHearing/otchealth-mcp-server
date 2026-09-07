/**
 * Resolve ownership only from provider-owned thread metadata. Hyperagent's live get_thread
 * response uses thread.namedAgentId (metadata-only verification, 2026-09-07).
 * Message text, requested agent intent, and caller-supplied owner values are never evidence.
 */
function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function id(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value === value.trim() ? value : null;
}

export function ownerAgentIdOf(data: unknown, expectedThreadId?: string): string | null {
  const envelope = record(data);
  if (!envelope) return null;
  const thread = Object.hasOwn(envelope, 'thread') ? record(envelope.thread) : envelope;
  if (!thread) return null;
  if (expectedThreadId !== undefined) {
    const identifiers = ['id', 'threadId'].filter(key => Object.hasOwn(thread, key))
      .map(key => id(thread[key]));
    if (!identifiers.length || identifiers.some(value => value !== expectedThreadId)) return null;
  }
  const owners = new Set<string>();
  for (const key of ['namedAgentId', 'agentId', 'agent_id', 'agentID']) {
    if (!Object.hasOwn(thread, key)) continue;
    const value = thread[key];
    // Explicitly unowned current-format threads cannot fall back to another alias.
    if (key !== 'namedAgentId' && (value === null || value === undefined)) continue;
    const owner = id(value);
    if (!owner) return null;
    owners.add(owner);
  }
  const agent = record(thread.agent);
  if (agent && Object.hasOwn(agent, 'id')) {
    const owner = id(agent.id);
    if (!owner) return null;
    owners.add(owner);
  }
  // Contradictory provider metadata is not resolved by arbitrary field precedence.
  return owners.size === 1 ? [...owners][0]! : null;
}
