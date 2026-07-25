import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { isConfigured, normalizeAgent, readSharedAll } from '../../memory/store.js';
import { semanticConfigured, semanticSearch } from '../../memory/semantic.js';
import { cachedAgenticRecall } from '../../memory/hot-cache.js';
import type { ToolContext, ToolResultPayload } from '../registry.js';

const RECALL_INPUT_SHAPE = {
  query: z.string().min(1).describe('Keywords to match against entry text, tags, type, and agent (case-insensitive; all terms must match).'),
  agent: z.string().optional().describe('Optional: restrict to one agent lane (e.g. "cto").'),
  limit: z.number().int().min(1).max(100).optional().describe('Max results (default 25).'),
};

const RECALL_OUTPUT_SHAPE = {
  matches: z.array(z.unknown()),
  count: z.number(),
  mode: z.string(),
};

/**
 * Shared recall handler, extracted (2026-07-25, M365 declarative-agent alias fix — see
 * recall-alias.ts's file header) so BOTH the canonical `memory_recall` tool and the `recall`
 * alias tool run the IDENTICAL logic. No behavior change from before the extraction.
 */
export async function recallHandler(
  input: { query: string; agent?: string; limit?: number },
  ctx: ToolContext,
): Promise<ToolResultPayload> {
  const limit = input.limit ?? 25;
  const agentFilter = input.agent ? normalizeAgent(input.agent) : null;

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
    const ar = await cachedAgenticRecall(input.query, {
      scope: ctx.callerAgent,
      agent: agentFilter ?? undefined,
      top: 5,
    });
    if ((ar.mode === 'agentic-hybrid' || ar.mode === 'cache-hit') && ar.results.length > 0) {
      const cacheNote = ar.cacheHit ? ' [cache hit]' : '';
      return {
        data: { matches: ar.results, count: ar.results.length, mode: ar.mode },
        summary: `${ar.results.length} agentic-hybrid match(es) for "${input.query}"${agentFilter ? ` in ${agentFilter}` : ''} (sub-queries: ${ar.subQueries.length})${cacheNote}.`,
      };
    }
  } catch {
    /* fall through to flat semantic / keyword */
  }

  // Flat SEMANTIC recall fallback: matches by meaning over the same memory-exec index.
  // Falls back to keyword over the blob feed when search isn't configured or errors.
  if (semanticConfigured()) {
    try {
      const hits = await semanticSearch(input.query, agentFilter, limit);
      if (hits) {
        return {
          data: { matches: hits, count: hits.length, mode: 'semantic' },
          summary: `${hits.length} semantic match(es) for "${input.query}"${agentFilter ? ` in ${agentFilter}` : ''}.`,
        };
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
  const matches = all
    .filter((r) => !agentFilter || r.agent === agentFilter)
    .filter((r) => {
      const hay = `${r.type} ${r.text} ${(r.tags || []).join(' ')} ${r.agent} ${r.source || ''}`.toLowerCase();
      return terms.every((t) => hay.includes(t));
    })
    .slice(0, limit);
  return {
    data: { matches, count: matches.length, mode: 'keyword' },
    summary: `${matches.length} keyword match(es) for "${input.query}"${agentFilter ? ` in ${agentFilter}` : ''}.`,
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
          'Search the cross-agent shared memory (kb-memory commons feed) for entries matching a query. Returns matching facts, decisions, corrections, pitfalls, and status across every agent, newest first. Use BEFORE asserting any cross-team fact: the ledger is the source of truth.',
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
