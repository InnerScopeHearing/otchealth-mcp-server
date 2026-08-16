import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { isConfigured } from '../../agentstate/store.js';
import { searchMemory, type MemoryRecord } from '../../agentstate/memory.js';
import { MEMORY_KINDS } from '../../agentstate/agents.js';
import { EXEC_RING, PERSONAL_LEGAL_RING, isExecRingLane } from '../kb/search-privileged.js';

/**
 * RING GATE (Wave 3 item 3.3, added 2026-07-22): memory_search's `agent` filter used to pass
 * straight through to searchMemory() with ZERO authorization check, and is registered on
 * EXTERNAL_READONLY_TOOLSET (registry.ts) -- the toolset handed to every self-registered,
 * non-privileged Claude Chat connector (auth/oauth.ts hard-binds these to the 'external-read'
 * lane). So ANY such caller could pass `agent:'clo-personal'` or `agent:'cfo'` and read every raw
 * Cosmos memory record (verbatim `text`, unredacted) for an EXEC_RING agent -- the exact same
 * class of MNPI + attorney-privileged exposure the OAuth self-mint hole (mcp-server #120) closed,
 * except reachable here even by a CORRECTLY-scoped external-read token. Worse, OMITTING `agent`
 * entirely did an unscoped, cross-PARTITION Cosmos query (searchMemory's `if (filter.agent)`
 * guard skips setting a partition key at all when unset), so a caller did not even need to know to
 * name a privileged agent; any `contains` text match against ANY agent's records, privileged or
 * not, would surface.
 *
 * This module fixes both paths with one pure, unit-tested decision function
 * (evaluateMemorySearchAccess) plus a thin authorization + post-filter wrapper in the handler:
 *   - a caller may always search their OWN agent's memory;
 *   - clo-personal's memory (the most sensitive ring, PERSONAL_LEGAL_RING) is readable only by
 *     clo-personal itself or exec, regardless of caller;
 *   - any OTHER EXEC_RING agent's memory (cfo/clo/cpo/cco/exec) is readable by any EXEC_RING
 *     caller (mirrors the existing exec-team cross-visibility model), never a non-exec caller;
 *   - a non-privileged agent's memory (developer, external-read, an app-lead identity, ...) stays
 *     open to any caller, unchanged -- this tool's whole reason for being on the external-readonly
 *     surface;
 *   - omitting `agent` force-scopes a non-EXEC_RING caller to their OWN agent only (never a global
 *     cross-partition scan), and lets an EXEC_RING caller run a genuine cross-agent search but
 *     strips any clo-personal record from the results unless the caller is itself clo-personal or
 *     exec;
 *   - a caller with no identifiable agent at all (should not happen in practice, defensive) is
 *     refused outright on an unscoped search rather than ever falling through to a global scan.
 *
 * This is a deterministic access-control gate (mirrors kb/search-privileged.ts's isLaneAllowed),
 * not a content-scanning safety module -- it does not "fail open" on ambiguity; every branch
 * resolves to an explicit allow or deny.
 */
export interface MemorySearchAccessDecision {
  allowed: boolean;
  /** When set, the search MUST be scoped to exactly this agent, overriding whatever (or nothing)
   *  the caller originally asked for. */
  forcedAgent?: string;
  /** When true, the search proceeds (possibly unscoped across every agent) but the caller-side
   *  handler must drop any clo-personal record from the results before returning them. */
  excludeClopersonalFromGlobal?: boolean;
  reason?: string;
}

function normalize(v: string | undefined | null): string {
  return (v || '').trim().toLowerCase();
}

export function evaluateMemorySearchAccess(callerAgent: string | undefined | null, requestedAgent: string | undefined | null): MemorySearchAccessDecision {
  const caller = normalize(callerAgent);
  const requested = normalize(requestedAgent);

  if (requested) {
    if (caller && requested === caller) return { allowed: true };
    if (requested === 'clo-personal') {
      return (PERSONAL_LEGAL_RING as readonly string[]).includes(caller)
        ? { allowed: true }
        : { allowed: false, reason: 'clo-personal memory is ring-gated to clo-personal/exec only' };
    }
    if ((EXEC_RING as readonly string[]).includes(requested)) {
      return isExecRingLane(caller)
        ? { allowed: true }
        : { allowed: false, reason: `"${requested}" is an executive-ring agent; only an EXEC_RING caller may search its memory` };
    }
    // A non-privileged agent (developer, external-read, an app-lead identity, ...): open to any caller,
    // unchanged from this tool's pre-existing behavior.
    return { allowed: true };
  }

  // No agent filter given (a global/cross-agent search).
  if (!caller) {
    return { allowed: false, reason: 'no caller identity; an unscoped memory_search requires a known caller lane' };
  }
  if (!isExecRingLane(caller)) {
    // Non-exec callers never get a cross-partition scan: force-scope to their own agent only.
    return { allowed: true, forcedAgent: caller };
  }
  // EXEC_RING caller, no agent filter: allow the genuine cross-agent search, but never let a
  // clo-personal record leak into it unless the caller IS clo-personal or exec.
  return { allowed: true, excludeClopersonalFromGlobal: !(PERSONAL_LEGAL_RING as readonly string[]).includes(caller) };
}

export function registerMemorySearch(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(
    server,
    {
      name: 'memory_search',
      category: 'read',
      annotations: {
        title: 'Search the structured memory-of-record',
        description:
          'Deterministic keyword/field search over the Cosmos memory store (by agent, kind, and/or a text substring). This is exact recall of the byte-exact record. For meaning-based semantic recall across all rooms, use the company-brain instead. RING GATE: searching your own agent, or a non-privileged agent, is always allowed; clo-personal is refused unless you are clo-personal/exec; any other executive-ring agent (cfo/clo/cpo/cco/exec) requires an executive-ring caller; omitting the agent filter never returns another ring-gated agent\'s records unless you are yourself entitled to read them.',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputShape: {
        agent: z.string().optional().describe('Filter by agent lane.'),
        kind: z.enum(MEMORY_KINDS).optional().describe('Filter by kind.'),
        contains: z.string().optional().describe('Case-insensitive substring match on the text.'),
        limit: z.number().int().min(1).max(100).optional().describe('Max results (default 25).'),
      },
      outputShape: { count: z.number(), records: z.unknown(), blocked: z.boolean().optional(), reason: z.string().optional() },
      handler: async (input, ctx) => {
        if (!isConfigured()) return { data: { count: 0, records: [], note: 'agent-state Cosmos not configured.' }, summary: 'Memory store not configured.' };

        const decision = evaluateMemorySearchAccess(ctx.callerAgent, input.agent);
        if (!decision.allowed) {
          return {
            data: { count: 0, records: [], blocked: true, reason: decision.reason },
            summary: `Refused: ${decision.reason}`,
          };
        }

        const effectiveInput = decision.forcedAgent ? { ...input, agent: decision.forcedAgent } : input;
        let records: MemoryRecord[] = await searchMemory(effectiveInput);
        if (decision.excludeClopersonalFromGlobal) {
          records = records.filter((r) => r.agent !== 'clo-personal');
        }
        return { data: { count: records.length, records }, summary: `${records.length} memory record(s).` };
      },
    },
    callerHash,
  );
}
