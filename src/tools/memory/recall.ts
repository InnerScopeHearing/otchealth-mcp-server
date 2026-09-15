import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { isConfigured, normalizeAgent, readSharedAll } from '../../memory/store.js';
import { semanticConfigured, semanticSearch } from '../../memory/semantic.js';
import { cachedAgenticRecall } from '../../memory/hot-cache.js';
import { agenticRecall } from '../../memory/agentic.js';
import type { ToolContext, ToolResultPayload } from '../registry.js';
import { filterPersonalSharedMemory, sharedMemoryAgentAllowed } from './shared-memory-access.js';
import { filterRetractedByAgent, retractedIdsByAgent } from '../../memory/retractions.js';

const RECALL_INPUT_SHAPE = {
  query: z.string().min(1).describe('Keywords to match against entry text, tags, type, and agent (case-insensitive; all terms must match).'),
  agent: z.string().optional().describe('Optional: restrict to one agent lane (e.g. "cto").'),
  limit: z.number().int().min(1).max(100).optional().describe('Max results (default 25).'),
  include_superseded: z.boolean().optional().describe('Audit-history mode. Include entries explicitly superseded by a newer record. Defaults to false so ordinary recall returns current truth only.'),
};

const RECALL_OUTPUT_SHAPE = {
  matches: z.array(z.unknown()),
  count: z.number(),
  mode: z.string(),
};

/**
 * `memory_recall` is a current-truth surface, unlike `memory_search`, which remains
 * the byte-exact audit-history tool. Apply the same agent-scoped retraction contract
 * already used by semantic brain search before returning any recall result. The
 * composite `{agent}__{entryId}` identity prevents one lane's retraction from hiding
 * another lane's same-day shared-feed ID.
 */
export function filterCurrentRecallHits<T extends { id?: unknown; agent?: unknown }>(
  hits: T[],
  retractedByAgent: Map<string, Set<string>>,
  includeSuperseded = false,
): T[] {
  return includeSuperseded ? hits : filterRetractedByAgent(hits, retractedByAgent).kept;
}

async function currentRecallHits<T extends { id?: unknown; agent?: unknown }>(
  hits: T[],
  includeSuperseded: boolean,
): Promise<T[]> {
  return filterCurrentRecallHits(hits, await retractedIdsByAgent(), includeSuperseded);
}

/**
 * Shared recall handler, extracted (2026-07-25, M365 declarative-agent alias fix — see
 * recall-alias.ts's file header) so BOTH the canonical `memory_recall` tool and the `recall`
 * alias tool run the IDENTICAL logic. No behavior change from before the extraction.
 */
export async function recallHandler(
  input: { query: string; agent?: string; limit?: number; include_superseded?: boolean },
  ctx: ToolContext,
): Promise<ToolResultPayload> {
  const limit = input.limit ?? 25;
  const includeSuperseded = input.include_superseded === true;
  // Filter retractions BEFORE applying the caller's limit. Fetch enough candidates that
  // several retired entries cannot crowd the current answer out of the result window.
  const candidateLimit = Math.min(100, Math.max(limit, limit * 4, 20));
  const agentFilter = input.agent ? normalizeAgent(input.agent) : null;
  if (!sharedMemoryAgentAllowed(ctx.callerAgent, agentFilter)) {
    return { data: { matches: [], count: 0, mode: 'ring-forbidden' }, summary: 'Refused: personal-legal shared-memory rows are not available to this caller.' };
  }

  // Prefer AGENTIC HYBRID recall (Azure AI Search memory-exec): decomposes the query into
  // focused sub-queries, fans out hybrid (BM25 + semantic-ranker) searches concurrently, and
  // fuses with Reciprocal Rank Fusion. Highest-quality recall for the whole fleet. Falls
  // through to flat semantic, then keyword, when search isn't configured or errors.
  //
  // A HOT read-through cache sits in front of this (Cosmos vector cache, cachedAgenticRecall):
  // near-duplicate repeat queries from the SAME caller lane skip the query-plan/hybrid/RRF
  // pipeline entirely. `scope` (the cache partition) is the caller's own OAuth-derived lane
  // (ctx.callerAgent) so results never cross agent lanes; `agent` is the unrelated content
  // filter above, forwarded through unchanged. The privilege-walled clo-personal lane is
  // never cached (defense in depth; it should never reach the gateway as a caller identity).
  try {
    let ar = await cachedAgenticRecall(input.query, {
      scope: ctx.callerAgent,
      agent: agentFilter ?? undefined,
      top: candidateLimit,
    });
    if ((ar.mode === 'agentic-hybrid' || ar.mode === 'cache-hit') && ar.results.length > 0) {
      let cacheNote = ar.cacheHit ? ' [cache hit]' : '';
      let visible = await currentRecallHits(filterPersonalSharedMemory(ar.results, ctx.callerAgent), includeSuperseded);
      // A cache entry can predate a retraction. On an all-retired cache hit, bypass it once
      // so a current record below the cached window still has a chance to surface.
      if (visible.length === 0 && ar.cacheHit && !includeSuperseded) {
        ar = { ...(await agenticRecall(input.query, { agent: agentFilter ?? undefined, top: candidateLimit })), cacheHit: false };
        cacheNote = '';
        visible = await currentRecallHits(filterPersonalSharedMemory(ar.results, ctx.callerAgent), includeSuperseded);
      }
      if (visible.length > 0) {
        const matches = visible.slice(0, limit);
        return {
          data: { matches, count: matches.length, mode: ar.mode },
          summary: `${matches.length} ${includeSuperseded ? 'audit-history' : 'current'} agentic-hybrid match(es) for "${input.query}"${agentFilter ? ` in ${agentFilter}` : ''} (sub-queries: ${ar.subQueries.length})${cacheNote}.`,
        };
      }
    }
  } catch {
    /* fall through to flat semantic / keyword */
  }

  // Flat SEMANTIC recall fallback: matches by meaning over the same memory-exec index.
  // Falls back to keyword over the blob feed when search isn't configured or errors.
  if (semanticConfigured()) {
    try {
      const hits = await semanticSearch(input.query, agentFilter, candidateLimit);
      if (hits) {
        const visible = await currentRecallHits(filterPersonalSharedMemory(hits, ctx.callerAgent), includeSuperseded);
        if (visible.length > 0) {
          const matches = visible.slice(0, limit);
          return {
            data: { matches, count: matches.length, mode: 'semantic' },
            summary: `${matches.length} ${includeSuperseded ? 'audit-history' : 'current'} semantic match(es) for "${input.query}"${agentFilter ? ` in ${agentFilter}` : ''}.`,
          };
        }
      }
    } catch {
      /* fall through to keyword */
    }
  }

  if (!isConfigured()) {
    return { data: { matches: [], count: 0, mode: 'none' }, summary: 'Shared brain not configured; no results.' };
  }
  const terms = input.query.toLowerCase().split(/\s+/).filter(Boolean);
  const all = await readSharedAll();
  const matches = filterPersonalSharedMemory(all, ctx.callerAgent)
    .filter((r) => !agentFilter || r.agent === agentFilter)
    .filter((r) => {
      const hay = `${r.type} ${r.text} ${(r.tags || []).join(' ')} ${r.agent} ${r.source || ''}`.toLowerCase();
      return terms.every((t) => hay.includes(t));
    });
  const current = await currentRecallHits(matches, includeSuperseded);
  const returned = current.slice(0, limit);
  return {
    data: { matches: returned, count: returned.length, mode: 'keyword' },
    summary: `${returned.length} ${includeSuperseded ? 'audit-history' : 'current'} keyword match(es) for "${input.query}"${agentFilter ? ` in ${agentFilter}` : ''}.`,
  };
}

export function registerMemoryRecall(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(
    server,
    {
      name: 'memory_recall',
      category: 'read',
      annotations: {
        title: 'Recall from the shared brain',
        description:
          'Search the cross-agent shared memory for current entries matching a query. Entries explicitly superseded by a newer record are excluded unless include_superseded is set for audit history. Use BEFORE asserting any cross-team fact: the ledger is the source of truth.',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputShape: RECALL_INPUT_SHAPE,
      outputShape: RECALL_OUTPUT_SHAPE,
      handler: recallHandler,
    },
    callerHash,
  );
}

export { RECALL_INPUT_SHAPE, RECALL_OUTPUT_SHAPE };
