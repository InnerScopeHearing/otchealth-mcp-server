import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { isConfigured, normalizeAgent, readSharedAgent, readSharedAll } from '../../memory/store.js';
import { semanticConfigured, semanticSearch } from '../../memory/semantic.js';
import { cachedAgenticRecall } from '../../memory/hot-cache.js';
import { agenticRecall } from '../../memory/agentic.js';
import type { ToolContext, ToolResultPayload } from '../registry.js';
import { filterPersonalSharedMemory, sharedMemoryAgentAllowed } from './shared-memory-access.js';
import { filterRetractedByAgent, getRetractionSnapshot, type RetractionSnapshot } from '../../memory/retractions.js';
import { sanitizeRetrievedPayload } from '../../safety/retrieval-redaction.js';

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

const EXACT_SHARED_ID = /^(?:([a-z0-9][a-z0-9_-]{0,40})__)?(\d{8}-(?:[a-fA-F0-9]{12}|\d{3}))(?:\s+((?=[A-Z0-9-]*\d)[A-Z0-9]+(?:-[A-Z0-9]+){2,}))?$/;

/** Recognize a whole stored ID, optionally followed by one opaque uppercase test marker. */
export function parseExactSharedIdQuery(query: string): { agent: string | null; id: string; marker: string | null } | null {
  const match = EXACT_SHARED_ID.exec(query.trim());
  if (!match) return null;
  try {
    return {
      agent: match[1] ? normalizeAgent(match[1]) : null,
      id: match[2]!.toLowerCase(),
      marker: match[3] ?? null,
    };
  } catch {
    return null;
  }
}

export function filterExactSharedIdHits<T extends { id?: unknown; agent?: unknown }>(
  rows: T[],
  id: string,
  agent: string | null,
): T[] {
  return rows.filter((row) => row.id === id && (!agent || row.agent === agent));
}

export async function resolveExactSharedId<T extends { id?: unknown; agent?: unknown }>(
  exactId: { agent: string | null; id: string; marker: string | null },
  agentFilter: string | null,
  readRows: (agent: string | null) => Promise<T[]>,
): Promise<{ handled: true; matches: T[] }> {
  if (exactId.agent && agentFilter && exactId.agent !== agentFilter) {
    return { handled: true, matches: [] };
  }
  const sourceAgent = exactId.agent ?? agentFilter;
  const rows = await readRows(sourceAgent);
  return { handled: true, matches: filterExactSharedIdHits(rows, exactId.id, sourceAgent) };
}

export interface RecallHandlerDependencies {
  readSharedAgent?: typeof readSharedAgent;
  readSharedAll?: typeof readSharedAll;
  getRetractionSnapshot?: typeof getRetractionSnapshot;
  isConfigured?: typeof isConfigured;
  semanticConfigured?: typeof semanticConfigured;
  cachedAgenticRecall?: typeof cachedAgenticRecall;
  semanticSearch?: typeof semanticSearch;
}

/**
 * `memory_recall` defaults to current truth; its explicit `include_superseded` mode
 * retains the append-only shared-feed history for audit. Apply the same agent-scoped
 * retraction contract already used by semantic brain search before returning any recall result. The
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

/**
 * Apply current-truth filtering only when both retraction authorities were read successfully.
 * An unverified empty or partial set cannot establish that a hit is current, so ordinary recall
 * fails closed. Explicit audit-history mode remains available for operators investigating the
 * degraded condition. Hash/row presence is not semantic entailment of the returned assertion.
 */
export function filterCurrentRecallHitsWithSnapshot<T extends { id?: unknown; agent?: unknown }>(
  hits: T[],
  snapshot: RetractionSnapshot,
  includeSuperseded = false,
): T[] {
  if (!includeSuperseded && !snapshot.verified) return [];
  return filterCurrentRecallHits(hits, snapshot.byAgent, includeSuperseded);
}

class RetractionAuthorityUnavailable extends Error {
  constructor() {
    super('Retraction authority is unavailable or incomplete; current recall is temporarily unavailable.');
    this.name = 'RetractionAuthorityUnavailable';
  }
}

async function currentRecallHits<T extends { id?: unknown; agent?: unknown }>(
  hits: T[],
  includeSuperseded: boolean,
  readRetractionSnapshot: typeof getRetractionSnapshot = getRetractionSnapshot,
): Promise<T[]> {
  const snapshot = await readRetractionSnapshot();
  if (!includeSuperseded && !snapshot.verified) throw new RetractionAuthorityUnavailable();
  return filterCurrentRecallHitsWithSnapshot(hits, snapshot, includeSuperseded);
}

/**
 * Shared recall handler, extracted (2026-07-25, M365 declarative-agent alias fix — see
 * recall-alias.ts's file header) so BOTH the canonical `memory_recall` tool and the `recall`
 * alias tool run the IDENTICAL logic, including the verified-retraction gate.
 */
async function recallHandlerImpl(
  input: { query: string; agent?: string; limit?: number; include_superseded?: boolean },
  ctx: ToolContext,
  dependencies: RecallHandlerDependencies = {},
): Promise<ToolResultPayload> {
  const limit = input.limit ?? 25;
  const includeSuperseded = input.include_superseded === true;
  const readRetractionSnapshot = dependencies.getRetractionSnapshot ?? getRetractionSnapshot;
  const readSharedAllForRecall = dependencies.readSharedAll ?? readSharedAll;
  const sharedMemoryConfigured = dependencies.isConfigured ?? isConfigured;
  const semanticSearchConfigured = dependencies.semanticConfigured ?? semanticConfigured;
  const runCachedAgenticRecall = dependencies.cachedAgenticRecall ?? cachedAgenticRecall;
  const runSemanticSearch = dependencies.semanticSearch ?? semanticSearch;
  // Filter retractions BEFORE applying the caller's limit. Fetch enough candidates that
  // several retired entries cannot crowd the current answer out of the result window.
  const candidateLimit = Math.min(100, Math.max(limit, limit * 4, 20));
  const agentFilter = input.agent ? normalizeAgent(input.agent) : null;
  if (!sharedMemoryAgentAllowed(ctx.callerAgent, agentFilter)) {
    return { data: { matches: [], count: 0, mode: 'ring-forbidden' }, summary: 'Refused: personal-legal shared-memory rows are not available to this caller.' };
  }

  // Exact shared-feed identifiers must not be sent through semantic ranking: hybrid search can
  // return a related row with a different ID. Agent-qualified IDs address the exact feed blob;
  // bare IDs with an explicit agent filter use the same single-feed read.
  const exactId = parseExactSharedIdQuery(input.query);
  if (exactId) {
    if (exactId.agent && !sharedMemoryAgentAllowed(ctx.callerAgent, exactId.agent)) {
      return { data: { matches: [], count: 0, mode: 'ring-forbidden' }, summary: 'Refused: personal-legal shared-memory rows are not available to this caller.' };
    }
    if (!sharedMemoryConfigured()) {
      return { data: { matches: [], count: 0, mode: 'none' }, summary: 'Shared brain not configured; no results.' };
    }
    const lookup = await resolveExactSharedId(exactId, agentFilter, (agent) =>
      agent
        ? (dependencies.readSharedAgent ?? readSharedAgent)(agent)
        : (dependencies.readSharedAll ?? readSharedAll)());
    const visible = await currentRecallHits(filterPersonalSharedMemory(lookup.matches, ctx.callerAgent), includeSuperseded, readRetractionSnapshot);
    const matches = visible.slice(0, limit);
    return {
      data: { matches, count: matches.length, mode: includeSuperseded ? 'exact-id-audit-history' : 'exact-id' },
      summary: `${matches.length} exact shared-memory ID match(es) for "${input.query}"${agentFilter ? ` in ${agentFilter}` : ''}.`,
    };
  }

  // Establish current-truth authority before any provider or model retrieval. The result is
  // rechecked immediately before filtering hits because the cache may change during retrieval.
  if (!includeSuperseded) {
    const preflight = await readRetractionSnapshot();
    if (!preflight.verified) throw new RetractionAuthorityUnavailable();
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
    let ar = await runCachedAgenticRecall(input.query, {
      scope: ctx.callerAgent,
      agent: agentFilter ?? undefined,
      top: candidateLimit,
    });
    if ((ar.mode === 'agentic-hybrid' || ar.mode === 'cache-hit') && ar.results.length > 0) {
      let cacheNote = ar.cacheHit ? ' [cache hit]' : '';
      let visible = await currentRecallHits(filterPersonalSharedMemory(ar.results, ctx.callerAgent), includeSuperseded, readRetractionSnapshot);
      // A cache entry can predate a retraction. On an all-retired cache hit, bypass it once
      // so a current record below the cached window still has a chance to surface.
      if (visible.length === 0 && ar.cacheHit && !includeSuperseded) {
        ar = { ...(await agenticRecall(input.query, { agent: agentFilter ?? undefined, top: candidateLimit })), cacheHit: false };
        cacheNote = '';
        visible = await currentRecallHits(filterPersonalSharedMemory(ar.results, ctx.callerAgent), includeSuperseded, readRetractionSnapshot);
      }
      if (visible.length > 0) {
        const matches = visible.slice(0, limit);
        return {
          data: { matches, count: matches.length, mode: includeSuperseded ? `${ar.mode}-audit-history` : ar.mode },
          summary: `${matches.length} ${includeSuperseded ? 'audit-history' : 'current'} agentic-hybrid match(es) for "${input.query}"${agentFilter ? ` in ${agentFilter}` : ''} (sub-queries: ${ar.subQueries.length})${cacheNote}.`,
        };
      }
    }
  } catch (error) {
    if (error instanceof RetractionAuthorityUnavailable) throw error;
    /* fall through to flat semantic / keyword */
  }

  // Flat SEMANTIC recall fallback: matches by meaning over the same memory-exec index.
  // Falls back to keyword over the blob feed when search isn't configured or errors.
  if (semanticSearchConfigured()) {
    try {
      const hits = await runSemanticSearch(input.query, agentFilter, candidateLimit);
      if (hits) {
        const visible = await currentRecallHits(filterPersonalSharedMemory(hits, ctx.callerAgent), includeSuperseded, readRetractionSnapshot);
        if (visible.length > 0) {
          const matches = visible.slice(0, limit);
          return {
            data: { matches, count: matches.length, mode: includeSuperseded ? 'semantic-audit-history' : 'semantic' },
            summary: `${matches.length} ${includeSuperseded ? 'audit-history' : 'current'} semantic match(es) for "${input.query}"${agentFilter ? ` in ${agentFilter}` : ''}.`,
          };
        }
      }
    } catch (error) {
      if (error instanceof RetractionAuthorityUnavailable) throw error;
      /* fall through to keyword */
    }
  }

  if (!sharedMemoryConfigured()) {
    return { data: { matches: [], count: 0, mode: 'none' }, summary: 'Shared brain not configured; no results.' };
  }
  const terms = input.query.toLowerCase().split(/\s+/).filter(Boolean);
  const all = await readSharedAllForRecall();
  const matches = filterPersonalSharedMemory(all, ctx.callerAgent)
    .filter((r) => !agentFilter || r.agent === agentFilter)
    .filter((r) => {
      const hay = `${r.type} ${r.text} ${(r.tags || []).join(' ')} ${r.agent} ${r.source || ''}`.toLowerCase();
      return terms.every((t) => hay.includes(t));
    });
  const current = await currentRecallHits(matches, includeSuperseded, readRetractionSnapshot);
  const returned = current.slice(0, limit);
  return {
    data: { matches: returned, count: returned.length, mode: includeSuperseded ? 'keyword-audit-history' : 'keyword' },
    summary: `${returned.length} ${includeSuperseded ? 'audit-history' : 'current'} keyword match(es) for "${input.query}"${agentFilter ? ` in ${agentFilter}` : ''}.`,
  };
}

/** Return an explicit degraded outcome instead of silently presenting zero current matches. */
export async function recallHandler(
  input: { query: string; agent?: string; limit?: number; include_superseded?: boolean },
  ctx: ToolContext,
  dependencies: RecallHandlerDependencies = {},
): Promise<ToolResultPayload> {
  try {
    return sanitizeRetrievedPayload(await recallHandlerImpl(input, ctx, dependencies));
  } catch (error) {
    if (error instanceof RetractionAuthorityUnavailable) {
      return {
        data: { matches: [], count: 0, mode: 'degraded-retraction-authority' },
        summary: 'Current recall temporarily unavailable because the retraction authority could not be verified. Retry after the memory stores recover, or request explicit audit-history mode.',
      };
    }
    throw error;
  }
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
