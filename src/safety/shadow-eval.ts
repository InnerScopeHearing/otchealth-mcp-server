/**
 * SHADOW EVAL. Runs a candidate retrieval/ranking variant against a SAMPLED slice of real queries,
 * IN PARALLEL with the live path, without ever affecting what the caller receives (AI-OS forward-
 * capability item 7.2, Wave 7).
 *
 * ============================ THE PROBLEM ============================
 * Today a change to retrieval logic (ranking, room-hygiene demotion, reranking) is validated only
 * by the offline golden-task eval suite (skills/recall-evals) before merge, then goes live for
 * 100% of real traffic the moment it deploys. There is no partial rollout of the RETRIEVAL LOGIC
 * itself (as distinct from the blue-green infrastructure cutover in deploy.yml, which shifts
 * traffic wholesale once health checks pass). A ranking regression is caught only after every
 * caller is already exposed to it.
 *
 * ============================ THE FIX ============================
 * A SECOND, independent code path re-runs the SAME query against `hybridSearch` with a candidate
 * option set (a named "strategy") named by SHADOW_EVAL_STRATEGY, for a SAMPLED fraction of real
 * calls (SHADOW_EVAL_SAMPLE_RATE, default 5%, bounded [0,1]). Its result is NEVER returned to the
 * caller. The live path's result is what the caller gets, byte-for-byte unchanged, exactly as
 * before this module existed. The shadow result is only CAPTURED (fire-and-forget, reusing the
 * exact durable-write pattern safety/journal.ts already established: writeMemory + write-through
 * indexMemoryNow, wrapped in one top-level try/catch so it can never throw or add latency),
 * alongside the live result, so a nightly job (not built in this change, this only makes the
 * comparison DATA available) can diff them offline and flag a regression before a full rollout.
 *
 * ============================ SHAPE (mirrors safety/journal.ts) ============================
 * A PURE core (mode/sample-rate parsing, a seedable PRNG plus the sampling decision, the named-
 * strategy registry, the bounded comparison-text builder) with no IO, no clock beyond an
 * injectable Date.now(), no network. Fully unit-testable without Cosmos or Azure AI Search. A
 * thin IO shell (`captureShadowComparison`) that owns the actual writeMemory + indexMemoryNow
 * calls. The orchestration itself (deciding to shadow, re-running the search with the candidate
 * variant, timing it) lives in azure/search.ts next to `hybridSearch`, the one place every
 * caller (kb_search, brain_search, kb_search_privileged, incident_match, deep-retrieval, ...)
 * already funnels through, so shadow coverage is automatic for every existing and future caller
 * with zero per-call-site wiring. This module intentionally has NO import of azure/search.ts (or
 * anything that transitively imports it) so azure/search.ts can import this module with no risk
 * of a cycle.
 *
 * ============================ DEFAULT OFF (report-mode-first) ============================
 * SHADOW_EVAL_MODE defaults to 'off', unlike most of this fleet's other advisory kill-switches
 * (COLD_START_MODE/CAPTURE_MODE/JIT_DOCTRINE_MODE default to their "on" advisory state). Shadow
 * eval is different in kind: turning it on doubles the retrieval cost (a second embed plus a
 * second Azure AI Search query) for every sampled call, so it is an explicit operator OPT-IN,
 * sized by SHADOW_EVAL_SAMPLE_RATE, never an ambient default. This is the "report-mode-first"
 * convention applied to a feature whose "on" state has a real, non-zero cost per sampled call.
 *
 * ============================ WHY CAPTURE REUSES 'episode' (not a new memory kind) ============
 * The comparison record is written as kind:'episode' (agentstate/agents.ts's MEMORY_KINDS), the
 * SAME kind safety/journal.ts already uses for its auto-journal entries, tagged distinctly
 * ('shadow-eval', the room, the strategy name) and under a dedicated 'shadow-eval' agent
 * partition. 'episode' is already listed in memory/room-hygiene.ts's EXHAUST_RECORD_TYPES, so a
 * shadow-eval comparison is automatically deprioritized (never hard-excluded) from default
 * brain_search/kb_search results with ZERO additional schema surface: no new MemoryKind, no new
 * exhaust-type entry, no new Cosmos container to provision. A nightly job reads them back via
 * `searchMemory({ agent: 'shadow-eval', kind: 'episode' })` (agentstate/memory.ts) or a
 * tags-CONTAINS-'shadow-eval' Cosmos query.
 *
 * ============================ FAIL-OPEN, NEVER THROW, ZERO LIVE-PATH LATENCY ============================
 * `captureShadowComparison` is always called via
 * `void captureShadowComparison(...).catch(() => undefined)` at the call site (azure/search.ts),
 * fired WITHOUT being awaited before the live path returns. See that file's `hybridSearch` for
 * the exact wiring, and its test file for a live proof that the returned promise resolves before
 * the shadow branch's own network call even settles. Its own body is one big try/catch, so the
 * returned promise never rejects either way; the `.catch()` at the call site is defense in depth,
 * matching journal.ts's own convention. A Cosmos/Search outage, or the shadow re-run itself
 * throwing, degrades to "no comparison written": it can NEVER fail, slow, or alter the tool call
 * whose result rides alongside it. The orchestration in azure/search.ts applies the identical
 * discipline to the shadow RE-RUN itself: a thrown error from the candidate variant's search is
 * caught and captured as `shadow_error`, never propagated.
 *
 * ============================ NON-PHI RING ============================
 * This module adds no new PHI path: it only ever captures gateway retrieval metadata (query text,
 * bounded plus secret-checked; hit ids/scores/types, never full match text) for rooms the caller
 * was already authorized to query. It does not change ring-gating and does not add a new room. The
 * shadow re-run reuses the exact same `index` and caller-supplied options the live call was given;
 * only the named strategy's ranking/demotion knobs differ.
 *
 * CROSS-RING GATE (the destination, not just the identity): `hybridSearch` is also the seam
 * kb_search_privileged funnels through, so a shadow-eval comparison could otherwise be sampled for a
 * ring-gated finance/legal query. The comparison record is always written under the fixed
 * 'shadow-eval' agent partition and indexed into the DEFAULT index (memory-exec, an OPEN room any
 * caller can read via kb_search/brain_search) -- a DIFFERENT, MORE PERMISSIVE destination than the
 * ring-gated room the live query was actually against, even though the sampling/identity itself never
 * changes. `isRingGatedIndexName`/`RING_GATED_INDEX_NAMES` below gate this: azure/search.ts's
 * `runShadowEvalIfSampled` skips even RUNNING the shadow re-run for a ring-gated index (no cost, no
 * capture), and `captureShadowComparison` repeats the same check as defense in depth.
 */
import { writeMemory } from '../agentstate/memory.js';
import { indexMemoryNow } from '../azure/search-write.js';
import { isConfigured as cosmosConfigured } from '../agentstate/cosmos.js';
import { looksLikeSecretValue } from './journal.js';

// ---- pure core: mode / sample-rate parsing --------------------------------------------------

export type ShadowEvalMode = 'off' | 'on';

/** Parse SHADOW_EVAL_MODE, defaulting to 'off' (fail-open toward NOT spending the extra retrieval
 *  cost, see the file header's "default off" rationale). Garbage/unset never crashes, it just
 *  picks the safe (inert) default. Pure. */
export function parseShadowEvalMode(value: string | undefined): ShadowEvalMode {
  return (value ?? '').trim().toLowerCase() === 'on' ? 'on' : 'off';
}

/** Default sample rate when SHADOW_EVAL_SAMPLE_RATE is unset/unparseable: 5%, inside the task's
 *  1-10% cost-bounding band. */
export const DEFAULT_SHADOW_SAMPLE_RATE = 0.05;

/** Parse SHADOW_EVAL_SAMPLE_RATE into a [0, 1] fraction. Anything unparseable (unset, empty,
 *  non-numeric, NaN, Infinity) falls back to DEFAULT_SHADOW_SAMPLE_RATE rather than throwing or
 *  sampling 0/100% by accident. A parsed value is clamped into [0, 1]: "150%" means "always",
 *  "-1" means "never", neither is a config error worth failing over. Pure. */
export function parseShadowSampleRate(value: string | undefined): number {
  const n = Number.parseFloat((value ?? '').trim());
  if (!Number.isFinite(n)) return DEFAULT_SHADOW_SAMPLE_RATE;
  return Math.min(1, Math.max(0, n));
}

// ---- pure core: seedable sampling ------------------------------------------------------------

/**
 * mulberry32. A small, fast, seedable PRNG returning floats in [0, 1). Deterministic: the SAME
 * seed always produces the SAME sequence, which is exactly what makes `shouldSampleShadow` unit-
 * testable ("prove roughly the right fraction of calls get shadowed" needs a repeatable sequence,
 * not real entropy). NOT cryptographically secure, this gates a telemetry sampling decision, not
 * a security boundary, so that tradeoff is fine. Pure.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The sampling decision itself: true when this call should ALSO run the shadow variant. Takes the
 * random source as a parameter (`rand`) rather than reaching for `Math.random()` internally, so it
 * stays pure and testable. The real call site (azure/search.ts) passes `Math.random`, a test
 * passes `mulberry32(seed)` for a repeatable sequence. `sampleRate <= 0` is a fast "never" path
 * that does not consume a `rand()` draw (so an operator who has fully disabled sampling via rate
 * 0, rather than via SHADOW_EVAL_MODE, never perturbs a shared/seeded RNG's sequence); `>= 1` is
 * likewise a fast "always" path with no draw. Pure given `rand`.
 */
export function shouldSampleShadow(sampleRate: number, rand: () => number): boolean {
  if (sampleRate <= 0) return false;
  if (sampleRate >= 1) return true;
  return rand() < sampleRate;
}

// ---- pure core: the named-strategy registry ---------------------------------------------------

/**
 * The overrides a named strategy applies to the SHADOW run only, the live run never sees these.
 * `includeOpsOverride` maps directly onto `HybridSearchOptions.includeOps` (room-hygiene
 * demotion). `rerankModeOverride` maps onto the MEMORY_RERANK_MODE the shadow run's authority
 * re-rank uses (azure/search.ts threads it through as an explicit parameter rather than reading
 * process.env a second time, so the shadow run can diverge from the live run's env-derived mode
 * without a second env mutation anywhere). `undefined` on either field means "inherit the live
 * call's value unchanged": a strategy only overrides what it names.
 */
export interface ShadowStrategyOverrides {
  includeOpsOverride?: boolean;
  rerankModeOverride?: string;
}

export interface ShadowStrategy {
  name: string;
  overrides: ShadowStrategyOverrides;
}

/**
 * The registry. Add a new named variant here, nothing else needs to change to make it
 * selectable via SHADOW_EVAL_STRATEGY. 'baseline' (also the fallback for an unknown/unset name)
 * is a genuine no-op re-run: same options, same env-derived rerank mode, so its own drift against
 * the live path is a sanity check on the eval pipeline itself (it should measure ~zero).
 */
const SHADOW_STRATEGIES: Record<string, ShadowStrategyOverrides> = {
  baseline: {},
  // Room-hygiene demotion candidates: what would ranking look like with exhaust demotion forced
  // off (native relevance order) or forced on, regardless of what the live caller asked for.
  'demote-off': { includeOpsOverride: true },
  'demote-on': { includeOpsOverride: false },
  // Authority/freshness re-rank candidates: what would ranking look like with the re-rank forced
  // off or on, regardless of the live MEMORY_RERANK_MODE.
  'rerank-off': { rerankModeOverride: 'off' },
  'rerank-on': { rerankModeOverride: 'on' },
};

/** Every strategy name the registry currently knows, for diagnostics/tests. Pure. */
export function listShadowStrategies(): string[] {
  return Object.keys(SHADOW_STRATEGIES);
}

/**
 * Resolve SHADOW_EVAL_STRATEGY to a strategy. An unrecognized or unset name falls back to
 * 'baseline' rather than throwing or disabling shadow mode outright: a config typo degrades to
 * "shadow-test a no-op variant" (harmless, still proves the pipeline works), never to a crash.
 * Case-insensitive, trimmed. Pure.
 */
export function resolveShadowStrategy(name: string | undefined): ShadowStrategy {
  const key = (name ?? '').trim().toLowerCase();
  if (key && Object.prototype.hasOwnProperty.call(SHADOW_STRATEGIES, key)) {
    return { name: key, overrides: SHADOW_STRATEGIES[key] };
  }
  return { name: 'baseline', overrides: SHADOW_STRATEGIES.baseline };
}

// ---- pure core: the bounded comparison payload -------------------------------------------------

export interface ShadowHitLite {
  id?: unknown;
  score?: number;
  type?: string;
}

export interface ShadowHitSummary {
  id: string;
  score: number | null;
  type: string | null;
}

/** Bound how many hits from each side are persisted, so a large `top` cannot blow past the total
 *  size cap below before truncation even gets a chance to run. */
const MAX_SHADOW_HITS = 10;

/** Project a KbHit-shaped array down to {id, score, type} only, never the match TEXT (the
 *  comparison exists to diff RANKING/PRESENCE, not to duplicate the room's content into a second
 *  store), capped to MAX_SHADOW_HITS entries. Pure; tolerant of odd/missing fields. */
export function summarizeHits(hits: readonly ShadowHitLite[] | null | undefined): ShadowHitSummary[] {
  if (!hits || !hits.length) return [];
  return hits.slice(0, MAX_SHADOW_HITS).map((h) => ({
    id: typeof h.id === 'string' ? h.id : h.id === undefined || h.id === null ? '' : String(h.id),
    score: typeof h.score === 'number' && Number.isFinite(h.score) ? h.score : null,
    type: typeof h.type === 'string' ? h.type : null,
  }));
}

const MAX_QUERY_CHARS = 300;

/** Cap plus defensively redact the query text before it is persisted. A search query should never
 *  itself contain a credential, but this reuses journal.ts's exact secret-value heuristic as
 *  defense in depth against a caller pasting one into a search box. Pure. */
export function sanitizeShadowQuery(query: string): string {
  const q = (query ?? '').toString();
  if (looksLikeSecretValue(q)) return '[REDACTED]';
  return q.length > MAX_QUERY_CHARS
    ? `${q.slice(0, MAX_QUERY_CHARS)}...[truncated ${q.length - MAX_QUERY_CHARS} chars]`
    : q;
}

/**
 * RING GATE (added after this file's initial build -- see tools/kb/search-privileged.ts's
 * INDEX_LANES for the canonical list this must stay in sync with; a cross-file test in
 * shadow-eval.test.ts imports INDEX_LANES directly and asserts the two enumerations match).
 *
 * hybridSearch (azure/search.ts) is the seam EVERY caller funnels through, including
 * kb_search_privileged against a ring-gated finance/legal room (MNPI, attorney-privileged). A
 * shadow-eval comparison is always written under the FIXED 'shadow-eval' agent partition and
 * indexed into the DEFAULT (memory-exec) index -- an OPEN index any caller can read via
 * kb_search/brain_search, not the ring-gated room the live query was actually against. Without
 * this gate, sampling a privileged-room query would leak its (sanitized-for-secrets-but-not-for-
 * MNPI) query text, the room's real name, and its hit ids into that open index the moment
 * SHADOW_EVAL_MODE is ever flipped to 'on'. This list is duplicated rather than imported from
 * search-privileged.ts on purpose: that file imports hybridSearch FROM azure/search.ts, and
 * azure/search.ts imports THIS module, so importing search-privileged.ts here would create a real
 * cycle (search.ts -> shadow-eval.ts -> search-privileged.ts -> search.ts) this module's own
 * header already commits to avoiding.
 */
export const RING_GATED_INDEX_NAMES = new Set([
  'finance-cfo-source-docs',
  'finance-otchealth-cfo-source-docs',
  'finance-cfo-memory',
  'legal-company',
  'legal-personal',
  'legal-personal-memory',
]);

/** True when `index` is one of the ring-gated (kb_search_privileged-only) rooms above. Pure. */
export function isRingGatedIndexName(index: string): boolean {
  return RING_GATED_INDEX_NAMES.has(index);
}

/** Whole-serialized-comparison cap, mirroring journal.ts's MAX_TOTAL_CHARS pattern (a bigger
 *  budget than journal.ts's 800: this payload carries two bounded hit lists, not one args blob). */
export const MAX_COMPARISON_CHARS = 2000;

export interface ShadowComparisonInput {
  index: string;
  query: string;
  top: number;
  strategy: string;
  live: { mode: string; hits: readonly ShadowHitLite[] };
  /** null when the shadow re-run itself threw (see `shadowError`) or was never configured. */
  shadow: { mode: string; hits: readonly ShadowHitLite[] } | null;
  shadowError?: string;
  elapsedMs: number;
}

/**
 * Pure, deterministic builder for the comparison record's persisted text: given the SAME input it
 * always produces the SAME JSON string. Truncates to a bounded preview (mirrors journal.ts's
 * redactArgs truncation shape) rather than ever emitting an unbounded payload.
 */
export function buildShadowComparisonText(input: ShadowComparisonInput): string {
  const payload: Record<string, unknown> = {
    index: input.index,
    strategy: input.strategy,
    top: input.top,
    query: sanitizeShadowQuery(input.query),
    live: { mode: input.live.mode, hits: summarizeHits(input.live.hits) },
    shadow: input.shadow ? { mode: input.shadow.mode, hits: summarizeHits(input.shadow.hits) } : null,
    elapsed_ms: Math.max(0, Math.round(input.elapsedMs)),
  };
  if (input.shadowError) payload.shadow_error = input.shadowError.slice(0, 200);
  const json = JSON.stringify(payload);
  if (json.length > MAX_COMPARISON_CHARS) {
    return JSON.stringify({
      index: input.index,
      strategy: input.strategy,
      _truncated: true,
      preview: `${json.slice(0, MAX_COMPARISON_CHARS)}...`,
    });
  }
  return json;
}

// ---- IO shell -----------------------------------------------------------------------------------

/** Fixed Cosmos/memory-exec partition every shadow-eval comparison is written under, so a nightly
 *  offline-comparison job can enumerate them with a single-partition query (`searchMemory({ agent:
 *  'shadow-eval', kind: 'episode' })`) instead of a cross-partition scan of every real agent. */
export const SHADOW_EVAL_AGENT = 'shadow-eval';

/**
 * Write one best-effort shadow-eval comparison record. FAIL-OPEN BY CONSTRUCTION: the entire body
 * is one try/catch, so this promise NEVER rejects, mirrors journal.ts's journalMutation exactly.
 * Callers fire it with `void captureShadowComparison(...).catch(() => undefined)` and never await
 * it, so a Cosmos/Search outage can never add latency to, or fail, the retrieval call it observes.
 *
 * Inert when agent-state Cosmos is not configured (mirrors every other agentstate tool's "not
 * configured" no-op, including journal.ts's own journalMutation). Persists via the SAME path
 * journal.ts uses: writeMemory (Cosmos, the verbatim system-of-record) plus indexMemoryNow
 * (write-through into memory-exec so a nightly job does not wait for the 6-hourly reindex).
 */
export async function captureShadowComparison(input: ShadowComparisonInput): Promise<void> {
  try {
    if (!cosmosConfigured()) return;
    // RING GATE (defense in depth; the primary gate is in azure/search.ts's runShadowEvalIfSampled,
    // which skips even RUNNING the shadow re-run for a ring-gated index so this never gets called
    // for one in practice). See isRingGatedIndexName's own doc comment for why this check exists at
    // all: the destination index below (memory-exec, via indexMemoryNow's default) is OPEN, not the
    // ring-gated room the live query was actually against.
    if (isRingGatedIndexName(input.index)) return;
    const text = buildShadowComparisonText(input);
    const record = await writeMemory({
      agent: SHADOW_EVAL_AGENT,
      kind: 'episode',
      text,
      tags: ['shadow-eval', input.index, input.strategy],
      source: `shadow-eval:${input.index}`,
    });
    await indexMemoryNow({
      agent: record.agent,
      id: record.id,
      type: record.kind,
      ts: record.created_at,
      tags: record.tags,
      text: record.text,
    });
  } catch {
    /* FAIL-OPEN: a shadow-eval capture failure must be completely invisible to the caller. */
  }
}
