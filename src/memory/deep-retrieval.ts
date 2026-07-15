/**
 * deepRetrieve — agentic "deep" retrieval mode for brain_search (Phase 4A, 2026-07-15).
 *
 * brain_search's existing ("fast") path runs ONE hybridSearch pass per room the caller may read,
 * fuses by rank (RRF), drops retracted beliefs, and returns raw passages for the CALLER to read and
 * synthesize. That is fast and cheap, but a caller still has to do its own multi-angle query
 * planning and its own synthesis. Deep mode moves that work server-side:
 *
 *   (a) PLAN   — an LLM (Foundry chat(), tier 'standard') decomposes the question into 2-4 focused
 *                sub-queries and may narrow which of the caller's ALREADY-PERMITTED rooms are worth
 *                targeting. The plan can only NARROW the room set the caller passes in — it can
 *                never expand it. Federation must never become a side door around a privilege
 *                boundary (the same invariant brain-search.ts documents for roomsFor()).
 *   (b) SEARCH — every sub-query runs against every target room via the EXISTING hybridSearch()
 *                (azure/search.ts) — the identical retrieval brain_search's fast path already uses.
 *                Sub-query results for a given room are fused into ONE ranked list for that room
 *                (reusing rrfFuse — see memory/rrf.ts), then every room's list is fused again into
 *                one pool (rrfFuse again) and deduped, mirroring how brain-search.ts's fast path
 *                fuses per-room lists, just with an extra intra-room fold for the sub-queries.
 *   (c) FUSE   — retraction filtering (memory/retractions.ts) runs on the fused pool exactly as it
 *                does for brain_search's fast path: a belief the fleet has retracted must not
 *                resurface as truth just because it arrived via a different retrieval strategy.
 *   (d) REFINE — if the fused pool still looks thin after round 1 (see fusedConfidence /
 *                needsRefine below), ONE additional LLM-planned round runs with reformulated
 *                sub-queries. Hard cap: MAX_ROUNDS total retrieval rounds, never more.
 *   (e) SYNTH  — an LLM (Foundry chat(), tier 'high' — this is the user-facing output, worth the
 *                better tier) writes a cited answer grounded ONLY in the retrieved passages
 *                (numbered [1], [2], ...), and says so plainly when the passages do not answer the
 *                question, rather than filling the gap from outside knowledge.
 *
 * FAIL-OPEN, end to end: deepRetrieve() NEVER throws. Every LLM step (plan / refine / synthesize)
 * degrades independently — a broken planner still lets retrieval and synthesis run with a trivial
 * one-sub-query plan; a broken synthesizer still returns the retrieved hits with a clear "synthesis
 * unavailable" note. If something UNEXPECTED still slips past those inline guards, the outermost
 * try/catch in deepRetrieve() falls all the way back to fallbackFastSearch() — literally the same
 * one-pass-per-room search brain_search's fast mode already runs — so deep mode can never be worse
 * than fast mode, only sometimes no better than it. Never call gpt-4.1-mini here (banned for
 * planning/synthesis quality — see azure/foundry.ts's cfg() comment); always go through chat()'s
 * 'standard' or 'high' tier.
 *
 * Kill switch: DEEP_RETRIEVAL_MODE (off | on, default on) — documented in config/env.ts alongside
 * COLD_START_MODE / JIT_DOCTRINE_MODE, same reasoning: read fresh from process.env at the call site
 * (tools/kb/brain-search.ts), NOT part of the parsed/cached Env object, so it can be flipped without
 * a redeploy. When off, brain-search.ts never calls into this module at all for mode:'deep' — it
 * just runs the fast path, so 'deep' behaves EXACTLY like 'fast'.
 */
import { chat, foundryConfigured, type ChatMessage } from '../azure/foundry.js';
import { hybridSearch, searchConfigured, type KbHit } from '../azure/search.js';
import { rrfFuse, type FusedHit } from './rrf.js';
import { retractedIds, filterRetracted } from './retractions.js';

// ---- constants ────────────────────────────────────────────────────────────────────────────────

const DEFAULT_TOP = 8;
/** Hard cap: round 1 (always) + AT MOST one refine round. Never more, regardless of how thin the
 *  pool still looks after the refine round. */
const MAX_ROUNDS = 2;
/** Below this many distinct fused hits, round 1's pool is thin enough to spend the ONE optional
 *  refine round on. RRF's own scores compress very tightly at k=60 (rank 1 vs rank 20 differ by
 *  less than 2x) and are not a reliable low/high signal on their own, so confidence here is
 *  COVERAGE (how much grounding material did we actually get), not score magnitude. */
export const CONFIDENCE_THRESHOLD = 3;
/** Bound on total (sub-query x room) hybridSearch calls issued in a single retrieval round, so a
 *  max-length plan (4 sub-queries) against a caller with the full ring room set (8 rooms) cannot
 *  balloon unboundedly. */
const MAX_FANOUT_PAIRS = 24;
/** How many of the final fused+deduped+retraction-filtered hits are actually handed to the
 *  synthesis prompt (token budget; `top` itself may be smaller or larger). */
const MAX_SYNTH_HITS = 12;

export const NO_CONTEXT_ANSWER = 'No grounded context was retrieved for this question.';
export const SYNTH_UNAVAILABLE_ANSWER = 'Synthesis is unavailable right now; see the retrieved passages below.';

// ---- public types ──────────────────────────────────────────────────────────────────────────────

export interface DeepRetrieveOptions {
  /** Rooms this caller is permitted to search — ALREADY ring-gated by the caller (brain-search.ts
   *  passes the exact result of its own roomsFor()). deepRetrieve never expands beyond this set;
   *  the LLM plan may only narrow it. */
  rooms: string[];
  /** Max fused hits returned in `hits`/`citations`. Default 8 (mirrors brain_search's fast default). */
  top?: number;
  /** Exclude operational exhaust (status/episode/heartbeat/digest chatter). Default false, mirroring
   *  brain_search's own include_ops default. */
  includeOps?: boolean;
}

export interface Citation {
  n: number;
  source: string;
  path?: string;
  id?: unknown;
}

export interface DeepRetrieveResult {
  mode: 'deep-agentic' | 'deep-fallback-fast' | 'unconfigured' | 'no-rooms';
  answer: string;
  citations: Citation[];
  sub_queries: string[];
  rounds_used: number;
  hits: FusedHit[];
  rooms_searched: string[];
  rooms_failed?: string[];
  retracted_dropped?: string[];
}

export interface QueryPlan {
  subQueries: string[];
  rooms: string[];
}

// ---- kill switch ───────────────────────────────────────────────────────────────────────────────

export type DeepRetrievalMode = 'off' | 'on';

/** Parse DEEP_RETRIEVAL_MODE, defaulting to 'on' (fail-open on garbage/unset input). Pure. */
export function parseDeepRetrievalMode(value: string | undefined): DeepRetrievalMode {
  return (value || '').trim().toLowerCase() === 'off' ? 'off' : 'on';
}

// ---- pure helpers (unit-tested) ───────────────────────────────────────────────────────────────

function dedupeCaseInsensitive(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const it of items) {
    const key = it.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(it);
    }
  }
  return out;
}

/**
 * Pure parse of the planner model's JSON reply into a validated plan. Defensive against a
 * malformed/partial/over-long model response (wrong types, extra keys, an unparseable body, an
 * empty plan). `rooms` is CLAMPED to `allowedRooms` — the model can narrow the search but can NEVER
 * expand it beyond what the caller is permitted to see; an invented room name is silently dropped,
 * never honored. Never throws.
 */
export function parseQueryPlan(raw: string, originalQuery: string, allowedRooms: string[]): QueryPlan {
  const allowedSet = new Set(allowedRooms);
  try {
    const parsed = JSON.parse(raw) as { sub_queries?: unknown; rooms?: unknown };
    const rawSubQueries = Array.isArray(parsed.sub_queries) ? parsed.sub_queries : [];
    const subQueries = dedupeCaseInsensitive(
      rawSubQueries
        .filter((q): q is string => typeof q === 'string' && q.trim().length > 0)
        .map((q) => q.trim().slice(0, 500)),
    ).slice(0, 4);
    const rawRooms = Array.isArray(parsed.rooms) ? parsed.rooms : [];
    const rooms = [...new Set(rawRooms.filter((r): r is string => typeof r === 'string' && allowedSet.has(r)))];
    return {
      subQueries: subQueries.length ? subQueries : [originalQuery],
      rooms: rooms.length ? rooms : [...allowedRooms],
    };
  } catch {
    return { subQueries: [originalQuery], rooms: [...allowedRooms] };
  }
}

/** Pure parse of the refine model's JSON reply into a validated, deduped-against-already-tried list
 *  of NEW sub-queries (capped at 3). Never throws; an unparseable/empty reply yields []. */
export function parseRefineResponse(raw: string, alreadyTried: string[]): string[] {
  const triedLower = new Set(alreadyTried.map((s) => s.trim().toLowerCase()));
  try {
    const parsed = JSON.parse(raw) as { sub_queries?: unknown };
    const arr = Array.isArray(parsed.sub_queries) ? parsed.sub_queries : [];
    const out: string[] = [];
    for (const q of arr) {
      if (typeof q !== 'string') continue;
      const trimmed = q.trim().slice(0, 500);
      if (!trimmed || triedLower.has(trimmed.toLowerCase())) continue;
      out.push(trimmed);
      if (out.length >= 3) break;
    }
    return out;
  } catch {
    return [];
  }
}

/** Pure cap on how many sub-queries are actually issued against a given room count, so total
 *  hybridSearch calls (sub-queries x rooms) in one round stay bounded even in the worst case (many
 *  allowed rooms, a max-length 4-sub-query plan). Never drops below 1 when there is at least one
 *  sub-query to run. */
export function boundSubQueries(subQueries: string[], roomCount: number): string[] {
  if (subQueries.length === 0) return [];
  if (roomCount <= 0) return subQueries.slice(0, 1);
  const maxAllowed = Math.max(1, Math.floor(MAX_FANOUT_PAIRS / roomCount));
  return subQueries.slice(0, Math.min(subQueries.length, maxAllowed));
}

/** A pure, cheap confidence proxy: the number of distinct fused hits retrieved. See the
 *  CONFIDENCE_THRESHOLD comment for why this is coverage-based rather than score-based. */
export function fusedConfidence(hits: FusedHit[]): number {
  return hits.length;
}

/** Pure decision: is `hits` weak enough to spend the ONE optional refine round on? Always false once
 *  `roundsUsed >= maxRounds` (the hard cap), regardless of how weak the pool still is. */
export function needsRefine(hits: FusedHit[], roundsUsed: number, maxRounds: number): boolean {
  if (roundsUsed >= maxRounds) return false;
  return fusedConfidence(hits) < CONFIDENCE_THRESHOLD;
}

/** Drop duplicate hits that share the same underlying document id (keeps the first / highest-scored
 *  occurrence — callers pass an already score-sorted pool). Needed because deep mode's two-level
 *  fusion (sub-queries fused per room, then rooms fused together) can retrieve the SAME document
 *  from two different sub-queries within one room; unlike brain_search's fast mode (a single query
 *  per room), that case does not otherwise arise, so rrfFuse itself has no id-dedupe of its own.
 *  Falls back to a text-prefix key when a hit carries no id (some rooms omit it). Pure. */
export function dedupeById(hits: FusedHit[]): FusedHit[] {
  const seen = new Set<string>();
  const out: FusedHit[] = [];
  for (const h of hits) {
    const key =
      (typeof h.id === 'string' && h.id) ||
      (typeof h.id === 'number' && String(h.id)) ||
      `text:${h.text.slice(0, 200)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(h);
  }
  return out;
}

/** citations are 1-based indices into `hits`, matching the [n] convention the synthesis prompt is
 *  told to cite with. Pure. */
export function buildCitations(hits: FusedHit[]): Citation[] {
  return hits.map((h, i) => {
    const c: Citation = { n: i + 1, source: h.source };
    if (h.path) c.path = h.path;
    if (h.id !== undefined) c.id = h.id;
    return c;
  });
}

// ---- LLM prompt builders (pure) ───────────────────────────────────────────────────────────────

const PLAN_SYSTEM_PROMPT =
  'You are a retrieval query planner for the OTCHealth company brain, a federated hybrid search ' +
  'over knowledge rooms. Given a user question, decompose it into 2 to 4 short, focused sub-queries ' +
  'that together cover the question. If the question is already narrow, it is fine to return just ' +
  'the original question once. Optionally name which of the ALLOWED ROOMS are most relevant to this ' +
  'question; when unsure, name none and every allowed room will be searched. Reply with JSON only, ' +
  'in this exact shape: {"sub_queries": ["...", ...], "rooms": ["...", ...]}. Never invent a room ' +
  'name outside the allowed list. Do not use em dashes or en dashes.';

export function buildPlanMessages(query: string, allowedRooms: string[]): ChatMessage[] {
  return [
    { role: 'system', content: PLAN_SYSTEM_PROMPT },
    { role: 'user', content: `ALLOWED ROOMS: ${allowedRooms.join(', ')}\n\nQUESTION: ${query}` },
  ];
}

const REFINE_SYSTEM_PROMPT =
  'You are a retrieval query planner refining a search that came back thin. Given the original ' +
  'question, the sub-queries already tried, and how many results they found, propose 1 to 3 NEW ' +
  'alternative sub-queries (different wording, synonyms, or a broader or narrower framing) that ' +
  'might surface what the first pass missed. Do not repeat a sub-query already tried. Reply with ' +
  'JSON only: {"sub_queries": ["...", ...]}. If you have no better ideas, reply {"sub_queries": []}. ' +
  'Do not use em dashes or en dashes.';

export function buildRefineMessages(query: string, triedSubQueries: string[], resultsSoFar: number): ChatMessage[] {
  return [
    { role: 'system', content: REFINE_SYSTEM_PROMPT },
    {
      role: 'user',
      content:
        `ORIGINAL QUESTION: ${query}\n` +
        `SUB-QUERIES ALREADY TRIED: ${triedSubQueries.join(' | ')}\n` +
        `RESULTS FOUND SO FAR: ${resultsSoFar}`,
    },
  ];
}

const SYNTH_SYSTEM_PROMPT =
  'You are the OTCHealth One Brain, answering ONLY from the numbered context passages given to you. ' +
  'Cite every claim with its passage number in square brackets, for example [1] or [2][3]. If the ' +
  'passages do not contain enough information to answer, say so plainly rather than guessing or ' +
  'using outside knowledge. Do not use em dashes or en dashes.';

function buildContextBlock(hits: FusedHit[]): string {
  return hits.map((h, i) => `[${i + 1}] (${h.source}${h.path ? `, ${h.path}` : ''})\n${h.text}`).join('\n\n');
}

export function buildSynthesisMessages(query: string, hits: FusedHit[]): ChatMessage[] {
  return [
    { role: 'system', content: SYNTH_SYSTEM_PROMPT },
    { role: 'user', content: `QUESTION: ${query}\n\nCONTEXT:\n${buildContextBlock(hits)}` },
  ];
}

// ---- IO: LLM calls (each individually fail-open) ─────────────────────────────────────────────

/** FAIL-OPEN: Foundry unconfigured or a chat() failure degrades to a trivial one-sub-query plan
 *  over every allowed room — never throws. */
async function planQuery(query: string, allowedRooms: string[]): Promise<QueryPlan> {
  if (!foundryConfigured()) return { subQueries: [query], rooms: allowedRooms };
  try {
    const res = await chat(buildPlanMessages(query, allowedRooms), { maxTokens: 500, jsonMode: true, tier: 'standard' });
    return parseQueryPlan(res.text, query, allowedRooms);
  } catch {
    return { subQueries: [query], rooms: allowedRooms };
  }
}

/** FAIL-OPEN: Foundry unconfigured or a chat() failure yields no refinement (the caller keeps
 *  round 1's hits rather than spending a round on a query set that failed to even plan) — never
 *  throws. */
async function refineSubQueries(query: string, triedSubQueries: string[], resultsSoFar: number): Promise<string[]> {
  if (!foundryConfigured()) return [];
  try {
    const res = await chat(buildRefineMessages(query, triedSubQueries, resultsSoFar), {
      maxTokens: 300,
      jsonMode: true,
      tier: 'standard',
    });
    return parseRefineResponse(res.text, triedSubQueries);
  } catch {
    return [];
  }
}

/** FAIL-OPEN: no hits -> a plain "nothing retrieved" note (no LLM call spent). Foundry unconfigured
 *  or a chat() failure -> a clear "synthesis unavailable" note, with the retrieved hits still
 *  returned by the caller. Never throws. Runs on tier 'high': this is the user-facing answer, the
 *  one step in the pipeline worth the better-quality deployment. */
async function synthesizeAnswer(query: string, hits: FusedHit[]): Promise<string> {
  if (hits.length === 0) return NO_CONTEXT_ANSWER;
  if (!foundryConfigured()) return SYNTH_UNAVAILABLE_ANSWER;
  try {
    const res = await chat(buildSynthesisMessages(query, hits.slice(0, MAX_SYNTH_HITS)), {
      maxTokens: 900,
      tier: 'high',
    });
    const text = res.text.trim();
    return text || SYNTH_UNAVAILABLE_ANSWER;
  } catch {
    return SYNTH_UNAVAILABLE_ANSWER;
  }
}

// ---- IO: retrieval ─────────────────────────────────────────────────────────────────────────────

type RoomHitList = { room: string; hits: Array<{ score?: number; text: string; id?: unknown; path?: string }> };

/**
 * One retrieval round: every (bounded) sub-query runs against every target room in parallel. A
 * room's sub-query result lists are fused into ONE ranked list for that room first (intra-room
 * fusion across sub-queries, reusing rrfFuse), so the round returns exactly one ranked list per
 * room searched — the same shape brain_search's fast path produces, just built from more than one
 * underlying query. A room where EVERY sub-query failed is reported as failed, not thrown; one dead
 * room must never take the whole round down (mirrors brain-search.ts's per-room error isolation).
 */
async function runRetrievalRound(
  subQueries: string[],
  rooms: string[],
  top: number,
  includeOps: boolean,
): Promise<{ perRoom: RoomHitList[]; searched: string[]; failed: string[] }> {
  const perRoomTop = Math.min(25, Math.max(top, 10));
  const bounded = boundSubQueries(subQueries, rooms.length);

  const settled = await Promise.allSettled(
    rooms.map(async (room): Promise<RoomHitList> => {
      const perSubQuery = await Promise.allSettled(bounded.map((sq) => hybridSearch(room, sq, perRoomTop, { includeOps })));
      const lists: Array<{ room: string; hits: KbHit[] }> = [];
      perSubQuery.forEach((s, i) => {
        if (s.status === 'fulfilled' && s.value) lists.push({ room: `sq${i}`, hits: s.value.matches });
      });
      if (lists.length === 0) throw new Error(`room ${room}: every sub-query failed`);
      // Intra-room fusion across this room's sub-query result lists — reuses the SAME rrfFuse.
      const fused = rrfFuse(lists, perRoomTop);
      return { room, hits: fused.map((f) => ({ score: f.score, text: f.text, id: f.id, path: f.path })) };
    }),
  );

  const perRoom: RoomHitList[] = [];
  const searched: string[] = [];
  const failed: string[] = [];
  settled.forEach((s, i) => {
    if (s.status === 'fulfilled') {
      perRoom.push(s.value);
      searched.push(s.value.room);
    } else {
      failed.push(rooms[i]!);
    }
  });
  return { perRoom, searched, failed };
}

/**
 * The full agentic pipeline (plan -> round 1 -> optional bounded refine round -> synthesize). Each
 * LLM step is individually fail-open (see planQuery/refineSubQueries/synthesizeAnswer); this
 * function itself can still throw on a genuinely unexpected error (e.g. hybridSearch's own thrown
 * errors on a non-400 failure — see azure/search.ts), which is exactly why deepRetrieve() wraps the
 * call to this function in its own outer try/catch down to fallbackFastSearch().
 */
async function runDeepFlow(query: string, rooms: string[], top: number, includeOps: boolean): Promise<DeepRetrieveResult> {
  const plan = await planQuery(query, rooms);
  let subQueries = plan.subQueries;
  const targetRooms = plan.rooms;

  const round1 = await runRetrievalRound(subQueries, targetRooms, top, includeOps);
  let rounds = 1;
  let pool = [...round1.perRoom];
  const searched = new Set(round1.searched);
  const failed = new Set(round1.failed);

  let fusedPreview = dedupeById(rrfFuse(pool, top * 3));

  if (needsRefine(fusedPreview, rounds, MAX_ROUNDS)) {
    const refined = await refineSubQueries(query, subQueries, fusedPreview.length);
    if (refined.length) {
      const round2 = await runRetrievalRound(refined, targetRooms, top, includeOps);
      rounds = 2;
      subQueries = [...subQueries, ...refined];
      pool = [...pool, ...round2.perRoom];
      for (const r of round2.searched) searched.add(r);
      for (const r of round2.failed) if (!searched.has(r)) failed.add(r);
      fusedPreview = dedupeById(rrfFuse(pool, top * 3));
    }
  }

  const retracted = await retractedIds();
  const { kept, dropped } = filterRetracted(fusedPreview, retracted);
  const hits = kept.slice(0, top);

  const answer = await synthesizeAnswer(query, hits);

  const result: DeepRetrieveResult = {
    mode: 'deep-agentic',
    answer,
    citations: buildCitations(hits),
    sub_queries: subQueries,
    rounds_used: rounds,
    hits,
    rooms_searched: [...searched],
  };
  if (failed.size) result.rooms_failed = [...failed];
  if (dropped.length) result.retracted_dropped = dropped;
  return result;
}

/**
 * The universal fallback: EXACTLY brain_search's fast-path shape (one hybridSearch pass per room,
 * rrfFuse, retraction filter) with no LLM involvement at all. This is what deep mode degrades to
 * when anything upstream goes wrong in a way the inline fail-opens did not already absorb. Wrapped
 * in its OWN try/catch as a last-resort belt-and-braces: even if AI Search itself is unreachable,
 * this returns a valid (empty) result shape rather than ever propagating a throw to the caller.
 */
async function fallbackFastSearch(query: string, rooms: string[], top: number, includeOps: boolean): Promise<DeepRetrieveResult> {
  try {
    const perRoomTop = Math.min(25, Math.max(top, 10));
    const settled = await Promise.allSettled(
      rooms.map(async (room) => ({ room, res: await hybridSearch(room, query, perRoomTop, { includeOps }) })),
    );
    const perRoom: RoomHitList[] = [];
    const searched: string[] = [];
    const failed: string[] = [];
    settled.forEach((s, i) => {
      if (s.status === 'fulfilled' && s.value.res) {
        perRoom.push({ room: s.value.room, hits: s.value.res.matches });
        searched.push(s.value.room);
      } else {
        failed.push(rooms[i]!);
      }
    });
    const pool = rrfFuse(perRoom, top * 3);
    const retracted = await retractedIds();
    const { kept, dropped } = filterRetracted(pool, retracted);
    const hits = kept.slice(0, top);
    const result: DeepRetrieveResult = {
      mode: 'deep-fallback-fast',
      answer: SYNTH_UNAVAILABLE_ANSWER,
      citations: buildCitations(hits),
      sub_queries: [query],
      rounds_used: 0,
      hits,
      rooms_searched: searched,
    };
    if (failed.length) result.rooms_failed = failed;
    if (dropped.length) result.retracted_dropped = dropped;
    return result;
  } catch {
    return {
      mode: 'deep-fallback-fast',
      answer: SYNTH_UNAVAILABLE_ANSWER,
      citations: [],
      sub_queries: [query],
      rounds_used: 0,
      hits: [],
      rooms_searched: [],
    };
  }
}

// ---- public entry point ───────────────────────────────────────────────────────────────────────

/**
 * Agentic deep retrieval. `opts.rooms` MUST already be ring-gated by the caller (brain-search.ts
 * passes its own roomsFor() result) — this function only ever narrows that set, never expands it.
 * FAIL-OPEN by construction: this can never throw. See the file header for the full fallback chain.
 */
export async function deepRetrieve(query: string, opts: DeepRetrieveOptions): Promise<DeepRetrieveResult> {
  const rooms = opts.rooms ?? [];
  const top = opts.top ?? DEFAULT_TOP;
  const includeOps = opts.includeOps ?? false;

  if (rooms.length === 0) {
    return { mode: 'no-rooms', answer: '', citations: [], sub_queries: [], rounds_used: 0, hits: [], rooms_searched: [] };
  }
  if (!searchConfigured()) {
    return { mode: 'unconfigured', answer: '', citations: [], sub_queries: [], rounds_used: 0, hits: [], rooms_searched: [] };
  }

  try {
    return await runDeepFlow(query, rooms, top, includeOps);
  } catch {
    // FAIL-OPEN: any unexpected error anywhere in the agentic flow degrades to a single plain
    // search pass across the same rooms — deep mode can never throw, and can never be WORSE than
    // brain_search's existing fast path, only sometimes no better than it.
    return fallbackFastSearch(query, rooms, top, includeOps);
  }
}
