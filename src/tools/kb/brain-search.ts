/**
 * brain_search — the One Brain, FEDERATED over the LIVE room indexes.
 *
 * ============================ WHY THIS WAS REWRITTEN (2026-07-13) ============================
 * This tool previously queried a single CONSOLIDATED index, `otchealth-brain` (67,645 docs, on a
 * separate `otchealth-brain-search` service). That index HAD NO WRITER. Not a broken writer -- no
 * writer at all: a grep of BOTH repos found the only reference to it outside this file was
 * fleet-backup, which READS it. Every real indexer writes somewhere else entirely
 * (semantic.mjs -> memory-exec; indexer.mjs push-search -> `{profile}-{container}`).
 *
 * So the One Brain was a one-time snapshot, frozen at ~2026-07-01, and it could never catch up.
 * Meanwhile every agent was instructed by this tool's own description to "Ground answers here and
 * cite." We spent ~12 days grounding answers in an index that had stopped learning. Measured
 * recall was hit@5 = 33% -- which was mostly STALENESS being mistaken for bad ranking, since the
 * SAME questions answered correctly at rank #1 against the live `memory-exec` index.
 *
 * Note the trap that hid it: the doc count stayed at exactly 67,645 the whole time. A doc count
 * proves an index HAS documents; it can never prove they are CURRENT. A frozen index doesn't drop
 * below a floor -- it stays identical, forever. Freshness must be asserted on the AGE of the
 * newest document, never on volume. (Ledger: 20260713-036.)
 *
 * ============================ THE FIX ============================
 * Federate. There is no consolidated copy to keep in sync, so it CANNOT go stale -- this deletes
 * the entire bug class rather than patching one instance of it. We fan out the query, in parallel,
 * to the live room indexes the caller is allowed to see, and fuse the results.
 *
 * Design notes:
 *  - Reuses `hybridSearch` (BM25 + vector + semantic reranker) -- the exact path kb_search uses and
 *    that is verified fresh -- instead of this tool's old bespoke semantic-only query.
 *  - Reuses `isLaneAllowed` from kb_search_privileged for ring-gating. The finance (MNPI) and legal
 *    (attorney-privileged) rings are NOT re-implemented here; federation must never become a side
 *    door around a privilege boundary, so a caller outside EXEC_RING simply never has those rooms
 *    fanned out to it.
 *  - Fuses with Reciprocal Rank Fusion (RRF, k=60). This matters: raw BM25/reranker scores are NOT
 *    comparable ACROSS indexes -- each index has its own scale -- so naively sorting by score would
 *    let one room's scoring quirks dominate. RRF ranks by POSITION, which is scale-free.
 *  - Per-room error isolation: one unreachable room degrades to a note, never a blank answer.
 *  - RETRACTION FILTERING (2026-07-14): a belief the fleet has explicitly retracted via `supersedes`
 *    is DROPPED from results. Before this, retrieval ignored `supersedes` entirely and served the
 *    retracted 20260713-015 at RANK #1, above the very correction that superseded it. See
 *    memory/retractions.ts. A ledger that cannot forget is not a memory -- it is a rumour mill.
 *  - ROOM HYGIENE (2026-07-15, DEMOTE not delete as of 2026-07-21): operational exhaust
 *    (status/episode/heartbeat/digest-style ledger chatter, see memory/room-hygiene.ts) is
 *    DEPRIORITIZED by default from every room that carries a `type` discriminator (memory-exec,
 *    finance-cfo-memory, legal-personal-memory), not removed: a high-volume "what I'm working on"
 *    status entry sorts after genuine facts/decisions in the fused results instead of diluting or
 *    outranking them, but it can still surface if a room genuinely has nothing better to offer, so
 *    a query never comes back empty just because its best match happens to be exhaust-typed. Pass
 *    `include_ops:true` for full inclusion at native relevance rank (e.g. "what has the CFO been
 *    doing lately"). Query-side only -- no indexing/data change. Fails open: a filter problem on a
 *    given room falls back to an unfiltered query for that room rather than breaking the room.
 *  - DEEP MODE (Phase 4A, 2026-07-15): `mode:'deep'` delegates to memory/deep-retrieval.ts -- an
 *    LLM-planned, multi-round agentic retrieval that ALSO synthesizes a cited answer, instead of
 *    just returning raw passages. `mode:'fast'` (the default, and the ONLY mode that existed before
 *    this change) is the untouched code path below, byte-identical to before. Gated by BOTH the
 *    caller's explicit request and the DEEP_RETRIEVAL_MODE kill-switch (config/env.ts) -- see
 *    handleBrainSearch. The handler body is exported as `handleBrainSearch` (rather than kept as an
 *    inline arrow function) so it is directly unit-testable without spinning up an MCP server,
 *    mirroring how memory/agentic.ts's exported functions are tested.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z, type ZodRawShape } from 'zod';
import { registerTool, type CallerHashProvider, type ToolContext, type ToolResultPayload } from '../registry.js';
import { hybridSearch, searchConfigured } from '../../azure/search.js';
import { isLaneAllowed } from './search-privileged.js';
import { retractedIds, filterRetracted } from '../../memory/retractions.js';
import { rrfFuse, type FusedHit } from '../../memory/rrf.js';
import { deepRetrieve, parseDeepRetrievalMode } from '../../memory/deep-retrieval.js';
import { lookupEntity } from '../../memory/entity-lookup.js';
import { tagWithFeedbackRefs } from '../../memory/retrieval-feedback.js';

// Re-exported so the pre-existing `import { rrfFuse, ... } from './brain-search.js'` in
// brain-search.test.ts keeps working unchanged -- the implementation moved to memory/rrf.ts (see
// that file's header) so memory/deep-retrieval.ts can reuse it without a tools -> memory -> tools
// import cycle, but this remains the SAME function, not a reimplementation.
export { rrfFuse };
export type { FusedHit };

/** Rooms every agent may read (non-PHI / non-MNPI / non-privileged). */
export const OPEN_ROOMS = ['memory-exec', 'commons-company-journal'] as const;

/** Rooms behind the executive ring. Gated via isLaneAllowed — never re-implemented here. */
export const RING_ROOMS = [
  'finance-cfo-source-docs',
  'finance-otchealth-cfo-source-docs',
  'finance-cfo-memory',
  'legal-company',
  'legal-personal',
  'legal-personal-memory',
] as const;

/** domain filter -> the rooms it maps to. Unknown/absent domain = every room the caller may see. */
const DOMAIN_ROOMS: Record<string, readonly string[]> = {
  exec: ['memory-exec'],
  commons: ['commons-company-journal'],
  ops: ['commons-company-journal'],
  finance: ['finance-cfo-source-docs', 'finance-otchealth-cfo-source-docs', 'finance-cfo-memory'],
  legal: ['legal-company', 'legal-personal', 'legal-personal-memory'],
};

/** The rooms this caller is permitted to search, optionally narrowed by a domain filter. Pure. */
export function roomsFor(caller: string | undefined | null, domain?: string): string[] {
  const permitted = [...OPEN_ROOMS, ...RING_ROOMS.filter((r) => isLaneAllowed(r, caller))];
  const d = (domain || '').trim().toLowerCase();
  if (!d) return permitted;
  const wanted = DOMAIN_ROOMS[d];
  if (!wanted) return permitted; // unknown domain -> don't silently return nothing
  return permitted.filter((r) => wanted.includes(r));
}

// FusedHit + rrfFuse now live in memory/rrf.ts and are imported + re-exported above.

/**
 * Declared once and shared between the tool registration (registerBrainSearch, below) and the
 * handler's own TS parameter type (BrainSearchInput) so the two can never drift out of sync --
 * `satisfies ZodRawShape` keeps it structurally checked against registerTool's expectations.
 */
export const brainSearchInputShape = {
  query: z.string().min(1).describe('Natural-language query.'),
  top: z.number().int().min(1).max(25).optional().describe('Max results (default 8).'),
  domain: z.string().optional().describe('Optional domain filter: exec|commons|ops|finance|legal.'),
  include_ops: z
    .boolean()
    .optional()
    .describe(
      'Include operational exhaust (status/episode/heartbeat/digest-style ledger chatter) at full relevance rank. By default (false) it is DEPRIORITIZED, not removed: it sorts after genuine facts/decisions and only fills a result slot when there is nothing better, so it can still appear rather than being impossible to return. Set true for questions ABOUT the operational chatter itself, e.g. "what has the CFO been working on."',
    ),
  mode: z
    .enum(['fast', 'deep'])
    .optional()
    .default('fast')
    .describe(
      'fast (default): one hybrid search pass per room, fused by rank -- the original brain_search behavior, unchanged. deep: agentic retrieval -- an LLM plans 2-4 sub-queries (and may narrow which of your permitted rooms to target), runs them, does ONE bounded evaluate-refine round if the results look thin, then synthesizes a cited answer from ONLY the retrieved passages. Slower and spends one or more Foundry calls; use it for a question fast mode answered poorly. Behaves exactly like fast when the DEEP_RETRIEVAL_MODE kill-switch is off.',
    ),
} satisfies ZodRawShape;

export type BrainSearchInput = z.infer<z.ZodObject<typeof brainSearchInputShape>>;

/**
 * The tool handler, extracted to a standalone exported function so it is directly unit-testable
 * (stub globalThis.fetch, call this with a fake ToolContext) without spinning up an MCP server --
 * mirrors how memory/agentic.ts's exported functions are tested. registerBrainSearch below wires
 * this in unchanged; nothing about registration or the MCP surface changes.
 */
export async function handleBrainSearch(input: BrainSearchInput, ctx: ToolContext): Promise<ToolResultPayload> {
  const top = input.top ?? 8;
  const includeOps = input.include_ops ?? false;
  if (!searchConfigured()) {
    return {
      data: { matches: [], count: 0, mode: 'unconfigured', rooms_searched: [], include_ops: includeOps },
      summary: 'AI Search not configured.',
    };
  }
  const rooms = roomsFor(ctx.callerAgent, input.domain);
  if (rooms.length === 0) {
    return {
      data: { matches: [], count: 0, mode: 'no-rooms', rooms_searched: [], include_ops: includeOps },
      summary: `No readable rooms for domain "${input.domain}".`,
    };
  }

  // DEEP MODE (Phase 4A): an LLM-planned, multi-round agentic retrieval that ALSO synthesizes a
  // cited answer, gated by BOTH the caller's explicit request (mode:'deep') AND the operator
  // kill-switch DEEP_RETRIEVAL_MODE (default on; read fresh from process.env here, same convention
  // as COLD_START_MODE/JIT_DOCTRINE_MODE -- see config/env.ts). When either condition is not met,
  // execution falls straight through to the untouched fast path below: deepRetrieve is not even
  // called, so 'fast' (the default, and every existing caller that never passes `mode` at all)
  // stays the EXACT prior code path, byte-identical output shape.
  if (input.mode === 'deep' && parseDeepRetrievalMode(process.env.DEEP_RETRIEVAL_MODE) === 'on') {
    const deep = await deepRetrieve(input.query, { rooms, top, includeOps });
    // Tag each hit with a feedback_ref (pure/synchronous, see memory/retrieval-feedback.ts) so a
    // later retrieval_feedback call can report whether it was useful without re-sending content.
    const taggedHits = tagWithFeedbackRefs(deep.hits, { tool: 'brain_search', query: input.query, defaultRoom: 'federated' });
    const data: Record<string, unknown> = {
      matches: taggedHits,
      count: taggedHits.length,
      mode: deep.mode,
      rooms_searched: deep.rooms_searched,
      include_ops: includeOps,
      answer: deep.answer,
      citations: deep.citations,
      sub_queries: deep.sub_queries,
      rounds_used: deep.rounds_used,
    };
    if (deep.rooms_failed?.length) data.rooms_failed = deep.rooms_failed;
    if (deep.retracted_dropped?.length) data.retracted_dropped = deep.retracted_dropped;

    const roundWord = deep.rounds_used === 1 ? 'round' : 'rounds';
    const sqWord = deep.sub_queries.length === 1 ? 'sub-query' : 'sub-queries';
    return {
      data,
      summary:
        `deep (${deep.rounds_used} ${roundWord}, ${deep.sub_queries.length} ${sqWord}): ${deep.hits.length} cited ` +
        `passage(s) for "${input.query}" across ${deep.rooms_searched.length} room(s): ${deep.rooms_searched.join(', ')}.` +
        (deep.rooms_failed?.length ? ` ${deep.rooms_failed.length} room(s) unreachable: ${deep.rooms_failed.join(', ')}.` : '') +
        (deep.retracted_dropped?.length ? ` Dropped ${deep.retracted_dropped.length} RETRACTED belief(s).` : ''),
    };
  }

  // ---- fast path: the ORIGINAL brain_search behavior, untouched line-for-line ----
  // Over-fetch per room so RRF has depth to fuse from, then trim to `top`.
  const perRoomTop = Math.min(25, Math.max(top, 10));
  const settled = await Promise.allSettled(
    rooms.map(async (room) => ({ room, res: await hybridSearch(room, input.query, perRoomTop, { includeOps }) })),
  );

  const perRoom: Array<{ room: string; hits: Array<{ score?: number; text: string; id?: unknown }> }> = [];
  const searched: string[] = [];
  const failed: string[] = [];
  for (let i = 0; i < settled.length; i++) {
    const s = settled[i];
    if (s.status === 'fulfilled' && s.value.res) {
      perRoom.push({ room: s.value.room, hits: s.value.res.matches });
      searched.push(s.value.room);
    } else {
      // One dead room must never blank the brain. Degrade, disclose, continue — WITH the reason,
      // so an agent (or the canary) can tell quota/semantic from auth from index-missing without
      // a human tailing gateway logs (the 2026-07-20 402 incident was undiagnosable client-side).
      const why = s.status === 'rejected' ? String((s.reason as Error)?.message ?? s.reason).slice(0, 80) : 'empty result';
      failed.push(`${rooms[i]}: ${why}`);
    }
  }

  // Fuse a WIDER pool first, drop retracted beliefs, and only THEN trim to `top` -- otherwise
  // removing a retracted hit would leave a hole instead of promoting a real result into its place.
  const pool = rrfFuse(perRoom, top * 3);
  const retracted = await retractedIds();
  const { kept, dropped } = filterRetracted(pool, retracted);

  // W1-3 DETERMINISTIC CURRENT-VALUE PROMOTION (fail-open, kill-switch ENTITY_LOOKUP_MODE). If the
  // query resolves to a known typed-entity key ("what is the ASC key id", "n8n base url"), surface
  // that key's CURRENT value AHEAD of the semantic top-k -- structurally unable to return a superseded
  // value, instead of whatever the reranker floated up. Ring-safe: the source is the commons feed and
  // entity rows are already in memory-exec (an OPEN_ROOM), so this changes RANKING, not exposure.
  const entity = await lookupEntity(input.query, process.env.ENTITY_LOOKUP_MODE);
  let matches: unknown[] = kept.slice(0, top);
  if (entity) {
    const recorded = (entity.ts || '').slice(0, 10);
    const authoritative: Record<string, unknown> = {
      id: entity.id,
      text: `${entity.ekey} = ${entity.evalue}${entity.source ? ` (source: ${entity.source})` : ''}${recorded ? ` [current value, recorded ${recorded}]` : ' [current value]'}`,
      score: Number.POSITIVE_INFINITY,
      type: 'entity',
      authoritative: true,
    };
    // Prepend the deterministic answer; drop any semantic duplicate of the same row so it is not
    // listed twice. Keep at least the authoritative hit even if top somehow rounds it out.
    matches = [
      authoritative,
      ...kept.filter((m) => String((m as { id?: unknown }).id ?? '') !== entity.id),
    ].slice(0, Math.max(top, 1));
  }

  // Tag each hit with a feedback_ref (pure/synchronous, see memory/retrieval-feedback.ts) so a
  // later retrieval_feedback call can report whether it was useful without re-sending content.
  // Runs AFTER the entity-answer promotion above so the synthetic authoritative row gets tagged too.
  const taggedMatches = tagWithFeedbackRefs(matches, { tool: 'brain_search', query: input.query, defaultRoom: 'federated' });

  const data: Record<string, unknown> = {
    matches: taggedMatches,
    count: taggedMatches.length,
    mode: 'federated-rrf',
    rooms_searched: searched,
    include_ops: includeOps,
  };
  if (entity) {
    data.entity_answer = {
      key: entity.ekey,
      value: entity.evalue,
      recorded: entity.ts,
      id: entity.id,
      ...(entity.source ? { source: entity.source } : {}),
    };
  }
  if (failed.length) data.rooms_failed = failed;
  // Disclose retractions rather than silently vanishing them -- an agent should be able to SEE
  // that the brain deliberately withheld a belief the fleet has retracted.
  if (dropped.length) data.retracted_dropped = dropped;

  return {
    data,
    summary:
      (entity ? `Current value: ${entity.ekey} = ${entity.evalue}. ` : '') +
      `${matches.length} match(es) for "${input.query}" — federated live across ${searched.length} room(s): ${searched.join(', ')}.` +
      (includeOps ? ' Operational chatter (status/episode/heartbeat/digest) INCLUDED.' : '') +
      (dropped.length ? ` Dropped ${dropped.length} RETRACTED belief(s): ${dropped.join(', ')}.` : '') +
      (failed.length ? ` ${failed.length} room(s) unreachable: ${failed.join(', ')}.` : ''),
  };
}

export function registerBrainSearch(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(
    server,
    {
      name: 'brain_search',
      category: 'read',
      annotations: {
        title: 'Search the OTCHealth One Brain (federated, always-fresh)',
        description:
          'Hybrid semantic search across the LIVE company brain, federated in parallel over every knowledge room you are permitted to read (memory-exec, commons-company-journal, plus the ring-gated finance/legal rooms for executive lanes) and fused by rank. Always current: it queries the live indexes directly rather than a consolidated copy that can go stale. Beliefs the fleet has retracted (via supersedes) are dropped, so a known-false answer cannot resurface as truth. Operational exhaust (status/episode/heartbeat/digest-style chatter) is deprioritized by default, not removed: it ranks after genuine results and only fills a slot when nothing better is available. Pass include_ops=true to see it at full relevance rank. Read-only. Ground answers here and cite. Optional domain filter: exec|commons|ops|finance|legal. Optional mode:\'deep\' for LLM-planned multi-round retrieval plus a synthesized cited answer (see the mode field). Each returned match carries a `feedback_ref` token; optionally report back with the retrieval_feedback tool (useful/not_useful/cited) once you know whether a hit actually helped, no content re-send needed -- this feeds future recall-quality work.',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputShape: brainSearchInputShape,
      outputShape: {
        matches: z.array(z.unknown()),
        count: z.number(),
        mode: z.string(),
        rooms_searched: z.array(z.string()),
        rooms_failed: z.array(z.string()).optional(),
        retracted_dropped: z.array(z.string()).optional(),
        include_ops: z.boolean(),
        // W1-3: the deterministic current-value answer when the query resolved to a typed-entity key.
        entity_answer: z.unknown().optional(),
        error: z.string().optional(),
        // deep mode only -- absent in fast mode, which stays byte-identical to before this change.
        answer: z.string().optional(),
        citations: z.array(z.unknown()).optional(),
        sub_queries: z.array(z.string()).optional(),
        rounds_used: z.number().optional(),
      },
      handler: handleBrainSearch,
    },
    callerHash,
  );
}
