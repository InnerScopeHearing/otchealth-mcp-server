/**
 * brain_search - the One Brain, FEDERATED over the LIVE room indexes.
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
import { hybridSearch, searchConfigured } from '../../search/index.js';
import { isLaneAllowed } from './search-privileged.js';
import { getRetractionSnapshot, filterRetractedByAgent, type retractedIdsByAgent } from '../../memory/retractions.js';
import { rrfFuse, type FusedHit } from '../../memory/rrf.js';
import { buildCitations, deepRetrieve, parseDeepRetrievalMode } from '../../memory/deep-retrieval.js';
import { lookupEntity, type EntityHit } from '../../memory/entity-lookup.js';
import { tagWithFeedbackRefs } from '../../memory/retrieval-feedback.js';
import { opaqueIdentifierQuery } from '../../search/identifier-match.js';

// Re-exported so the pre-existing `import { rrfFuse, ... } from './brain-search.js'` in
// brain-search.test.ts keeps working unchanged -- the implementation moved to memory/rrf.ts (see
// that file's header) so memory/deep-retrieval.ts can reuse it without a tools -> memory -> tools
// import cycle, but this remains the SAME function, not a reimplementation.
export { rrfFuse };
export type { FusedHit };

/** Fuse the normal bounded pool while retaining a direct exact-ID candidate ahead of truncation.
 * Retraction filtering still runs after this helper, so retention cannot revive a withdrawn row. */
export function fuseWithDirectCandidate(
  perRoom: Array<{ room: string; hits: Array<{ score?: number; text: string; id?: unknown; path?: string; agent?: string; variants?: string[]; type?: string; source_version?: string }> }>,
  top: number,
  directCandidate?: FusedHit,
): FusedHit[] {
  const pool = rrfFuse(perRoom, top * 3);
  if (!directCandidate) return pool;
  return [directCandidate, ...pool.filter((hit) =>
    hit.source !== directCandidate.source || String(hit.id ?? '') !== String(directCandidate.id ?? '') ||
    hit.source_version !== directCandidate.source_version)];
}

/** Keep opaque identifiers out of natural-language ranking. Mirrors the OpenSearch detector. */
export function isOpaqueIdentifierQuery(query: string): boolean {
  return opaqueIdentifierQuery(query) !== null;
}

/** A backend can mark a full-source literal witness before it truncates its public snippet. */
export function exactIdentifierCandidate(
  query: string,
  room: string,
  hits: Array<{ score?: number; text: string; id?: unknown; path?: string; agent?: string; variants?: string[]; type?: string; source_version?: string; exactIdentifierMatch?: unknown }>,
): FusedHit | undefined {
  if (!isOpaqueIdentifierQuery(query)) return undefined;
  const hit = hits.find((value) => value.exactIdentifierMatch === true);
  return hit ? { score: 1, source: room, text: hit.text, id: hit.id, path: hit.path, agent: hit.agent, variants: hit.variants, type: hit.type, source_version: hit.source_version } : undefined;
}


/** Typed entities live in memory-exec. Domain narrowing must remain authoritative. */
export function canUseEntityLookup(rooms: readonly string[]): boolean {
  return rooms.includes('memory-exec');
}

/** Build the public promotion and metadata from one already-authorized entity hit. Pure. */
export function buildEntityPromotion(entity: EntityHit): {
  match: Record<string, unknown>;
  answer: Record<string, unknown>;
} {
  const recorded = (entity.ts || '').slice(0, 10);
  return {
    match: {
      id: entity.id,
      text: `${entity.ekey} = ${entity.evalue}${entity.source ? ` (source: ${entity.source})` : ''}${recorded ? ` [current value, recorded ${recorded}]` : ' [current value]'}`,
      score: 1,
      type: 'entity',
      authoritative: true,
      ...(entity.owner ? { agent: entity.owner } : {}),
      ...(entity.matchedBy ? { matched_by: entity.matchedBy } : {}),
    },
    answer: {
      key: entity.ekey,
      value: entity.evalue,
      recorded: entity.ts,
      id: entity.id,
      ...(entity.source ? { source: entity.source } : {}),
      ...(entity.owner ? { owner: entity.owner } : {}),
      ...(entity.matchedBy ? { matched_by: entity.matchedBy } : {}),
    },
  };
}

/** Entity feed IDs may be bare ledger IDs while search hits use `{agent}__{id}` doc IDs. */
function isEntityDuplicate(hit: FusedHit, entity: EntityHit): boolean {
  const hitId = String(hit.id ?? '');
  if (!hitId || !entity.id) return false;
  const owner = (entity.owner || '').trim().toLowerCase();
  const separator = hitId.indexOf('__');
  const hitOwner = separator > 0
    ? hitId.slice(0, separator).toLowerCase()
    : (typeof hit.agent === 'string' ? hit.agent.trim().toLowerCase() : '');
  if (owner && hitOwner && owner !== hitOwner) return false;
  const hitEntryId = separator > 0 ? hitId.slice(separator + 2) : hitId;
  const entitySeparator = entity.id.indexOf('__');
  const entityEntryId = entitySeparator > 0 ? entity.id.slice(entitySeparator + 2) : entity.id;
  return hitEntryId === entityEntryId;
}

/** Rooms every agent may read (non-PHI / non-MNPI / non-privileged). */
export const OPEN_ROOMS = ['memory-exec', 'commons-company-journal'] as const;

/** Rooms behind the executive ring. Gated via isLaneAllowed - never re-implemented here. */
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
      'fast (default): one hybrid search pass per room, fused by rank -- the original brain_search behavior, unchanged. deep: agentic retrieval -- an LLM plans 2-4 sub-queries (and may narrow which of your permitted rooms to target), runs them, does ONE bounded evaluate-refine round if the results look thin, then synthesizes a cited answer from ONLY the retrieved passages. Slower and spends one or more Foundry calls; use it for a question fast mode answered poorly. Behaves exactly like fast when the DEEP_RETRIEVAL_MODE kill-switch is off. deep mode is wall-clock budgeted (well under any 45-second-class MCP client timeout): if the budget runs out before the cited answer can be synthesized, the response comes back with partial:true, the FULL retrieved/citable hits (nothing is dropped), and a continuation -- pass that continuation straight back on your next mode:"deep" call to resume directly into synthesis under a fresh budget.',
    ),
  continuation: z
    .object({
      rooms: z.array(z.string()),
      sub_queries: z.array(z.string()),
      rounds_used: z.number(),
    })
    .optional()
    .describe(
      'deep mode only. Pass back the `continuation` object from a prior partial:true deep response to skip re-planning and resume straight into retrieval + synthesis under a fresh budget. Ignored in fast mode. Room names are re-validated against your OWN current permissions on every call -- a continuation can never grant access to a room you would not otherwise be allowed to search.',
    ),
} satisfies ZodRawShape;

export type BrainSearchInput = z.infer<z.ZodObject<typeof brainSearchInputShape>>;

/**
 * The tool handler, extracted to a standalone exported function so it is directly unit-testable
 * (stub globalThis.fetch, call this with a fake ToolContext) without spinning up an MCP server --
 * mirrors how memory/agentic.ts's exported functions are tested. registerBrainSearch below wires
 * this in unchanged; nothing about registration or the MCP surface changes.
 */
export interface BrainSearchDependencies {
  /** Provider-free handler seam; production uses the existing current-entity lookup. */
  lookupEntity?: typeof lookupEntity;
  /** Provider-free handler seam; production uses the existing lane-scoped retraction reader. */
  retractedIdsByAgent?: typeof retractedIdsByAgent;
  /** Provider-free handler seam for exercising deep response and shield outcomes. */
  deepRetrieve?: typeof deepRetrieve;
}

export async function handleBrainSearch(
  input: BrainSearchInput,
  ctx: ToolContext,
  dependencies: BrainSearchDependencies = {},
): Promise<ToolResultPayload> {
  const top = input.top ?? 8;
  const includeOps = input.include_ops ?? false;
  const resolveEntity = dependencies.lookupEntity ?? lookupEntity;
  const readSnapshot = dependencies.retractedIdsByAgent
    ? async () => ({ byAgent: await dependencies.retractedIdsByAgent!(), verified: true })
    : getRetractionSnapshot;
  const retrieveDeep = dependencies.deepRetrieve ?? deepRetrieve;
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
    const retrieved = await retrieveDeep(input.query, { rooms, top, includeOps, continuation: input.continuation });
    // Capture after retrieval so local writes during synthesis cannot re-promote a stale entity.
    const retractionSnapshot = await readSnapshot();
    const boundary = filterRetractedByAgent(retrieved.hits, retractionSnapshot.byAgent);
    const retractionChanged = boundary.dropped.length > 0;
    // A late retraction invalidates the generated answer. Preserve live evidence and a resume
    // contract instead of returning stale synthesis or making an unbudgeted second provider call.
    const deep = retractionChanged ? {
      ...retrieved,
      hits: boundary.kept,
      citations: buildCitations(boundary.kept),
      answer: 'A supporting memory was retracted during retrieval. Resume to synthesize from current evidence.',
      partial: true,
      continuation: retrieved.continuation ?? { rooms: retrieved.rooms_searched, sub_queries: retrieved.sub_queries, rounds_used: retrieved.rounds_used },
      retracted_dropped: [...new Set([...(retrieved.retracted_dropped ?? []), ...boundary.dropped])],
    } : retrieved;
    // Keep the existing typed-entity path's exact room gate and full lane-scoped retraction map.
    // Deep retrieval has already completed its normal shield path before we promote anything.
    const entityRetractions = retractionSnapshot.byAgent;
    const entity = canUseEntityLookup(rooms)
      ? await resolveEntity(input.query, process.env.ENTITY_LOOKUP_MODE, entityRetractions)
      : null;
    const candidatePromotion = entity ? buildEntityPromotion(entity) : null;
    const enforceShield = (process.env.RETRIEVAL_SHIELD_MODE || 'report').trim().toLowerCase() === 'enforce';
    // deepRetrieve screens the first 12 synthesis hits; later hits provide no screening proof.
    const entityWasScreened = Boolean(entity && candidatePromotion && deep.hits.slice(0, 12).some((hit) =>
      isEntityDuplicate(hit, entity) && hit.text === candidatePromotion.match['text'],
    ));
    const shieldWithheld = Boolean(enforceShield && (
      !deep.injection_screen ||
      deep.injection_screen.mode !== 'enforce' ||
      deep.injection_screen.attackDetected ||
      !entityWasScreened
    ));
    const promotion = entity && !shieldWithheld && !deep.partial ? candidatePromotion : null;
    const authoritative = promotion
      ? ({ ...promotion.match, source: 'memory-exec' } as unknown as FusedHit)
      : null;
    const entityId = entity?.id ?? '';
    const deepHits = promotion && authoritative
      ? [authoritative, ...deep.hits.filter((hit) => !entityId || !isEntityDuplicate(hit, entity!))]
      : deep.hits;
    const deepAnswer = promotion && !deep.partial
      ? `Current value: ${entity!.ekey} = ${entity!.evalue} [1].`
      : deep.answer;
    const citations = promotion && !deep.partial && authoritative
      ? buildCitations([authoritative])
      : promotion && deep.partial
        ? buildCitations(deepHits)
        : deep.citations;
    // Tag each hit with a feedback_ref (pure/synchronous, see memory/retrieval-feedback.ts) so a
    // later retrieval_feedback call can report whether it was useful without re-sending content.
    const taggedHits = tagWithFeedbackRefs(deepHits, { tool: 'brain_search', query: input.query, defaultRoom: 'federated' });
    const data: Record<string, unknown> = {
      matches: taggedHits,
      count: taggedHits.length,
      mode: deep.mode,
      rooms_searched: deep.rooms_searched,
      include_ops: includeOps,
      answer: deepAnswer,
      citations,
      sub_queries: deep.sub_queries,
      rounds_used: deep.rounds_used,
      retraction_verification: retractionSnapshot.verified ? 'complete' : 'incomplete',
    };
    if (promotion) data.entity_answer = promotion.answer;
    if (retractionChanged) data.retraction_changed = true;
    if (deep.rooms_failed?.length) data.rooms_failed = deep.rooms_failed;
    if (deep.retracted_dropped?.length) data.retracted_dropped = deep.retracted_dropped;
    // Only present when the content-level injection screen actually ran (RETRIEVAL_SHIELD_MODE != off
    // AND Content Safety configured) -- see memory/deep-retrieval.ts's runDeepFlow.
    if (deep.injection_screen) data.injection_screen = deep.injection_screen;
    // FND-20260829-e454 (wall-clock budget): present only when the budget was actually exhausted
    // (partial) or a stage was skipped purely for time (budget_skipped) or a continuation was
    // consumed (resumed) -- an ordinary, fully-completed deep call carries none of these, so its
    // shape is unchanged from before this fix.
    if (deep.partial) data.partial = true;
    if (deep.continuation) data.continuation = deep.continuation;
    if (deep.resumed) data.resumed = true;
    if (deep.budget_skipped?.length) data.budget_skipped = deep.budget_skipped;

    const roundWord = deep.rounds_used === 1 ? 'round' : 'rounds';
    const sqWord = deep.sub_queries.length === 1 ? 'sub-query' : 'sub-queries';
    const citedHitCount = promotion && !deep.partial ? 1 : deepHits.length;
    return {
      data,
      summary:
        `deep (${deep.rounds_used} ${roundWord}, ${deep.sub_queries.length} ${sqWord}): ${citedHitCount} cited ` +
        `passage(s) for "${input.query}" across ${deep.rooms_searched.length} room(s): ${deep.rooms_searched.join(', ')}.` +
        (promotion ? ` Current value: ${entity!.ekey} = ${entity!.evalue}.` : '') +
        (retractionChanged ? ' Retraction state changed; resume before relying on synthesis.' : '') +
        (deep.rooms_failed?.length ? ` ${deep.rooms_failed.length} room(s) unreachable: ${deep.rooms_failed.join(', ')}.` : '') +
        (deep.retracted_dropped?.length ? ` Dropped ${deep.retracted_dropped.length} RETRACTED belief(s).` : '') +
        (!retractionSnapshot.verified ? ' Retraction verification incomplete; one or more sources were unavailable.' : '') +
        (deep.injection_screen?.attackDetected
          ? ` INJECTION SCREEN flagged a retrieved passage (mode=${deep.injection_screen.mode}).`
          : '') +
        (deep.partial && !retractionChanged
          ? ' BUDGET: the wall-clock budget ran out before synthesis; pass back `continuation` to resume.'
          : '') +
        (deep.budget_skipped?.length ? ` Skipped for time: ${deep.budget_skipped.join(', ')}.` : ''),
    };
  }

  // ---- fast path: the ORIGINAL brain_search behavior, untouched line-for-line ----
  // Over-fetch per room so RRF has depth to fuse from, then trim to `top`.
  const perRoomTop = Math.min(25, Math.max(top, 10));
  const settled = await Promise.allSettled(
    rooms.map(async (room) => ({ room, res: await hybridSearch(room, input.query, perRoomTop, { includeOps }) })),
  );

  const perRoom: Array<{ room: string; hits: Array<{ score?: number; text: string; id?: unknown; path?: string; agent?: string; variants?: string[]; type?: string; source_version?: string }> }> = [];
  const searched: string[] = [];
  const failed: string[] = [];
  let directCandidate: FusedHit | undefined;
  let identifierCandidate: FusedHit | undefined;
  for (let i = 0; i < settled.length; i++) {
    const s = settled[i];
    if (s.status === 'fulfilled' && s.value.res) {
      perRoom.push({ room: s.value.room, hits: s.value.res.matches });
      searched.push(s.value.room);
      if (!directCandidate && s.value.res.mode === 'direct-id') {
        const exact = s.value.res.matches.find((hit) => String(hit.id ?? '') === input.query.trim());
        if (exact) {
          directCandidate = {
            score: 1,
            source: s.value.room,
            text: exact.text,
            id: exact.id,
            path: exact.path,
            agent: exact.agent,
            variants: exact.variants,
            type: exact.type,
            source_version: exact.source_version,
          };
        }
      }
      if (!identifierCandidate) {
        identifierCandidate = exactIdentifierCandidate(input.query, s.value.room, s.value.res.matches);
      }
    } else {
      // One dead room must never blank the brain. Degrade, disclose, continue - WITH the reason,
      // so an agent (or the canary) can tell quota/semantic from auth from index-missing without
      // a human tailing gateway logs (the 2026-07-20 402 incident was undiagnosable client-side).
      const why = s.status === 'rejected' ? String((s.reason as Error)?.message ?? s.reason).slice(0, 80) : 'empty result';
      failed.push(`${rooms[i]}: ${why}`);
    }
  }

  // Fuse a WIDER pool first, drop retracted beliefs, and only THEN trim to `top` -- otherwise
  // removing a retracted hit would leave a hole instead of promoting a real result into its place.
  const preferredCandidate = directCandidate ?? identifierCandidate;
  const pool = fuseWithDirectCandidate(perRoom, top, preferredCandidate);
  const retractionSnapshot = await readSnapshot();
  const retracted = retractionSnapshot.byAgent;
  const { kept, dropped } = filterRetractedByAgent(pool, retracted);
  const directSurvived = Boolean(directCandidate && kept.some((hit) =>
    hit.source === directCandidate?.source && String(hit.id ?? '') === String(directCandidate?.id ?? '') &&
    hit.source_version === directCandidate?.source_version));
  const identifierSurvived = Boolean(!directCandidate && identifierCandidate && kept.some((hit) =>
    hit.source === identifierCandidate?.source && String(hit.id ?? '') === String(identifierCandidate?.id ?? '') &&
    hit.source_version === identifierCandidate?.source_version));

  // W1-3 DETERMINISTIC CURRENT-VALUE PROMOTION (fail-open, kill-switch ENTITY_LOOKUP_MODE). If the
  // query resolves to a known typed-entity key ("what is the ASC key id", "n8n base url"), surface
  // that key's CURRENT value AHEAD of the semantic top-k -- structurally unable to return a superseded
  // value, instead of whatever the reranker floated up. Ring-safe: the source is the commons feed and
  // entity rows are already in memory-exec (an OPEN_ROOM), so this changes RANKING, not exposure.
  const entity = canUseEntityLookup(rooms)
    ? await resolveEntity(input.query, process.env.ENTITY_LOOKUP_MODE, retracted)
    : null;
  const promotion = entity ? buildEntityPromotion(entity) : null;
  let matches: unknown[] = kept.slice(0, top);
  if (entity && promotion) {
    const authoritative = promotion.match;
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
    mode: directSurvived ? 'direct-id' : identifierSurvived ? 'identifier-match' : 'federated-rrf',
    rooms_searched: searched,
    include_ops: includeOps,
    retraction_verification: retractionSnapshot.verified ? 'complete' : 'incomplete',
  };
  if (promotion) data.entity_answer = promotion.answer;
  if (failed.length) data.rooms_failed = failed;
  // Disclose retractions rather than silently vanishing them -- an agent should be able to SEE
  // that the brain deliberately withheld a belief the fleet has retracted.
  if (dropped.length) data.retracted_dropped = dropped;

  return {
    data,
    summary:
      (entity ? `Current value: ${entity.ekey} = ${entity.evalue}. ` : '') +
      `${matches.length} match(es) for "${input.query}" - federated live across ${searched.length} room(s): ${searched.join(', ')}.` +
      (includeOps ? ' Operational chatter (status/episode/heartbeat/digest) INCLUDED.' : '') +
      (dropped.length ? ` Dropped ${dropped.length} RETRACTED belief(s): ${dropped.join(', ')}.` : '') +
      (!retractionSnapshot.verified ? ' Retraction verification incomplete; one or more sources were unavailable.' : '') +
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
          'Hybrid semantic search across the LIVE company brain, federated in parallel over every knowledge room you are permitted to read (memory-exec, commons-company-journal, plus the ring-gated finance/legal rooms for executive lanes) and fused by rank. Always current: it queries the live indexes directly rather than a consolidated copy that can go stale. Beliefs the fleet has retracted (via supersedes) are dropped, so a known-false answer cannot resurface as truth; each result reports whether retraction verification completed. Operational exhaust (status/episode/heartbeat/digest-style chatter) is deprioritized by default, not removed: it ranks after genuine results and only fills a slot when nothing better is available. Pass include_ops=true to see it at full relevance rank. Read-only. Ground answers here and cite. Optional domain filter: exec|commons|ops|finance|legal. Optional mode:\'deep\' for LLM-planned multi-round retrieval plus a synthesized cited answer (see the mode field); deep mode also screens the retrieved passages for embedded prompt-injection attempts before synthesizing (see injection_screen). Each returned match carries a `feedback_ref` token; optionally report back with the retrieval_feedback tool (useful/not_useful/cited) once you know whether a hit actually helped, no content re-send needed -- this feeds future recall-quality work.',
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
        retraction_verification: z.enum(['complete', 'incomplete']).optional(),
        retraction_changed: z.boolean().optional(),
        include_ops: z.boolean(),
        // W1-3: the deterministic current-value answer when the query resolved to a typed-entity key.
        entity_answer: z.unknown().optional(),
        error: z.string().optional(),
        // deep mode only -- absent in fast mode, which stays byte-identical to before this change.
        answer: z.string().optional(),
        citations: z.array(z.unknown()).optional(),
        sub_queries: z.array(z.string()).optional(),
        rounds_used: z.number().optional(),
        // deep mode only, and only present when the injection screen actually ran (Content Safety
        // configured AND RETRIEVAL_SHIELD_MODE != off) -- see memory/deep-retrieval.ts.
        injection_screen: z.unknown().optional(),
        // FND-20260829-e454 (deep mode wall-clock budget) -- all four deep-mode-only, and each
        // present only when actually true/non-empty, so a normal deep result (let alone fast mode)
        // is unchanged by this fix. See memory/deep-retrieval.ts's budget block.
        partial: z.boolean().optional(),
        continuation: z
          .object({ rooms: z.array(z.string()), sub_queries: z.array(z.string()), rounds_used: z.number() })
          .optional(),
        resumed: z.boolean().optional(),
        budget_skipped: z.array(z.string()).optional(),
      },
      handler: handleBrainSearch,
    },
    callerHash,
  );
}
