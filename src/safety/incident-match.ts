/**
 * INCIDENT MATCH (Phase 4, component C): "you have been here before." Takes free text describing
 * what is happening RIGHT NOW and semantically surfaces the single most similar PAST pitfall or
 * correction recorded in the shared brain (memory-exec), if one clears a confidence threshold.
 *
 * Sibling to safety/jit-doctrine.ts (same pure-decision-core + thin-IO-shell shape, same in-memory
 * per-process throttle, same fail-open-by-construction guarantee) but answers a different question:
 * jit-doctrine asks "is there a KNOWN, ALREADY-BOUND pitfall for the tool you are about to call"
 * (a small, hand-curated table keyed on tool name); incident-match asks "does the SITUATION you are
 * DESCRIBING resemble any past pitfall/correction in the brain" (an open-ended semantic search over
 * everything the fleet has ever recorded, keyed on meaning, not on tool name). jit-doctrine is
 * precise-but-narrow; incident-match is broad-but-fuzzy. Both are advisory nudges, never gates.
 *
 * ============================ SHAPE (mirrors jit-doctrine.ts) ============================
 * A PURE core (pickBestIncident / agentFromId / buildTypeInFilterClause / parseIncidentMatchMode)
 * with no IO, no Set, no clock -- fully unit-testable without Azure Search or Foundry. A thin IO
 * shell (matchIncident) that owns the actual hybridSearch call, and a throttled evaluate wrapper
 * (evaluateIncidentMatch) that composes the mode gate + the IO shell + the per-(caller,incident)
 * throttle, mirroring jit-doctrine's evaluateJitDoctrine(callerHash, toolName).
 *
 * ============================ REUSE, NOT REIMPLEMENT ============================
 * The retrieval itself is entirely azure/search.ts's hybridSearch() (BM25 + vector + semantic
 * reranker, with its own fail-open degrade-to-keyword retry) -- hybridSearch already calls
 * azure/foundry.ts's embed() internally to build the vector query, so this module never calls
 * embed() a second time. The only new capability this module needed from hybridSearch was a way to
 * query a SPECIFIC slice of the room (`type in (pitfall, correction)`) instead of "every knowledge
 * type except operational exhaust" -- added as an optional `filter` override on HybridSearchOptions
 * (azure/search.ts), additive and backward compatible (every existing caller is unaffected).
 *
 * ============================ CONFIDENCE THRESHOLD ============================
 * Azure AI Search's semantic-reranker score runs 0..4; empirically ~1.5 is a reasonably confident
 * topical match and ~2.0+ is a strong one (the same score field brain_search/kb_search already
 * surface as KbHit.score). When hybridSearch degrades to keyword-only (semantic ranker unsupported
 * on this SKU, or a filter 400), the score is instead a BM25 @search.score on a different, unbounded
 * scale -- an existing wrinkle shared by every hybridSearch consumer (brain_search/kb_search never
 * normalize between the two scales either, and fixing that is out of scope here). The default is
 * deliberately conservative: this is advisory recall, not a gate, so a false "no match" only costs a
 * missed nudge, never a wrong action -- the safe failure direction is silence, not a bad match.
 *
 * ============================ THE THROTTLE IS ANNOTATION-ONLY, NOT SUPPRESSION ============================
 * jit-doctrine's once-per-(caller,tool) throttle SUPPRESSES a repeat nag because its pitfalls ride
 * passively on an unrelated tool call the agent did not ask about. incident_match is the opposite:
 * an agent calls it BECAUSE it wants to know "have I been here before" -- silently withholding a
 * real match on a repeat call would make a true "yes" look like a false "no", which is actively
 * harmful for a safety-recall tool. So shouldSurfaceIncident/evaluateIncidentMatch here NEVER hide a
 * real match; the throttle only sets `already_surfaced: true` on the outcome so a caller MAY choose
 * to de-emphasize a repeat. It exists in this shape now so a FUTURE fast-follow (wiring matchIncident
 * into the shared hot mutation path the way jit-doctrine is wired into registry.ts -- explicitly
 * deferred, see the tool file's header) can reuse it for true nag-suppression once matches ride
 * passively instead of being explicitly requested.
 *
 *  - INCIDENT_MATCH_MODE is read FRESH from process.env per call (off | on (default)), same
 *    reasoning as AUTO_JOURNAL_MODE/JIT_DOCTRINE_MODE (config/env.ts): flip by env change, no
 *    redeploy required.
 *  - CRITICAL fail-open: an unconfigured Foundry/Search, a network outage, a malformed hit, or any
 *    internal error NEVER throws -- matchIncident/evaluateIncidentMatch always degrade to "no match"
 *    rather than ever failing the caller.
 *  - The gateway runs 2-10 replicas behind the load balancer, so (like jit-doctrine's throttle) the
 *    once-per-(caller,incident) Set is PER-REPLICA: a caller whose calls land on different replicas
 *    may see `already_surfaced` under-report. Acceptable -- it is a soft annotation, not a
 *    correctness guarantee, exactly the same caveat jit-doctrine.ts documents for its own Set.
 */
import { hybridSearch, searchConfigured, type KbHit } from '../azure/search.js';

/** The two durable memory kinds this recall targets (see agentstate/agents.ts MEMORY_KINDS for the
 *  full durable-kind vocabulary: fact/decision/correction/pitfall/status/episode). Only the two
 *  "something went wrong / here is the corrected belief" kinds are incident-shaped; fact/decision
 *  are not "have I been here before" material. */
export const INCIDENT_TYPES = ['pitfall', 'correction'] as const;

/** The room this recall targets. memory-exec is the OPEN, non-ring-gated shared exec brain (see
 *  kb/brain-search.ts OPEN_ROOMS / kb/search.ts OPEN_INDEXES) -- every agent may read it, so
 *  incident-match needs no additional ring gating of its own. */
export const INCIDENT_MATCH_INDEX = 'memory-exec';

/** See the file header's CONFIDENCE THRESHOLD section for the reasoning behind this default. */
export const DEFAULT_MIN_CONFIDENCE = 1.5;

/** How many candidates to fetch before picking the single best one. Small on purpose -- this tool
 *  only ever returns one hit, so there is no value in a deep over-fetch (unlike brain_search's RRF
 *  fusion across many rooms, which needs depth to fuse from). */
const DEFAULT_TOP = 5;

export interface IncidentMatch {
  /** The past pitfall/correction text, verbatim (truncated by hybridSearch's own 1200-char cap). */
  text: string;
  /** 'pitfall' | 'correction' -- the memory kind that was matched. */
  type?: string;
  /** Confidence score of the match (semantic reranker 0..4, or a BM25 keyword-only fallback score
   *  on a different scale -- see the file header). */
  score: number;
  /** The memory-exec doc id, `{agent}__{entryId}` (see azure/search-write.ts memoryDocId) -- the
   *  citation for this room. */
  id?: string;
  /** Source path, when the underlying hit carries one (memory-exec is a FLAT room and normally
   *  carries no path; carried through defensively for shape-parity with the chunked-room citation
   *  convention brain_search/kb_search already use). */
  path?: string;
  /** The agent lane that recorded the original incident, parsed from `id` when possible. */
  agent?: string;
}

/** Parse the `{agent}__{entryId}` doc id convention (azure/search-write.ts's memoryDocId) to
 *  recover the recording agent for citation. Pure; undefined on anything that does not match. */
export function agentFromId(id: string | undefined): string | undefined {
  if (!id) return undefined;
  const i = id.indexOf('__');
  return i > 0 ? id.slice(0, i) : undefined;
}

/**
 * Build an Azure AI Search OData $filter clause matching ANY of the given `type` values, e.g.
 * "type eq 'pitfall' or type eq 'correction'". Pure string construction -- cannot throw. Mirrors
 * memory/room-hygiene.ts's buildExhaustFilterClause (a NOT-equal AND-chain, for exclusion) but for
 * an INCLUSION set instead, joined with `or`. Single quotes are escaped per OData convention, though
 * every value in INCIDENT_TYPES today is a plain lower-kebab slug.
 */
export function buildTypeInFilterClause(types: readonly string[], field = 'type'): string {
  return types.map((t) => `${field} eq '${t.replace(/'/g, "''")}'`).join(' or ');
}

/**
 * Pure decision core: given hybridSearch hits (any order), return the SINGLE highest-scored one as
 * an IncidentMatch, but ONLY when its score clears `threshold` -- otherwise null. No IO, no clock,
 * no process.env -- fully deterministic and unit-testable in isolation from Azure Search/Foundry.
 * A hit with a missing/non-finite score is never eligible to be "best" (there is nothing to compare
 * a confidence threshold against). Never throws (a missing/empty `hits` array just yields null).
 */
export function pickBestIncident(
  hits: readonly KbHit[],
  threshold: number = DEFAULT_MIN_CONFIDENCE,
): IncidentMatch | null {
  if (!hits || !hits.length) return null;
  let best: KbHit | null = null;
  for (const h of hits) {
    if (typeof h.score !== 'number' || !Number.isFinite(h.score)) continue;
    if (!best || h.score > (best.score as number)) best = h;
  }
  if (!best || typeof best.score !== 'number' || best.score < threshold) return null;
  const id = best.id == null ? undefined : typeof best.id === 'string' ? best.id : String(best.id);
  return {
    text: best.text,
    type: best.type,
    score: best.score,
    id,
    path: best.path,
    agent: agentFromId(id),
  };
}

/**
 * IO shell: embed + vector-query memory-exec (via the existing hybridSearch(), which owns the
 * embedding internally) filtered to `type in (pitfall, correction)`, and return the single best hit
 * above the confidence threshold, or null. FAIL-OPEN BY CONSTRUCTION: the entire body is one
 * try/catch, so this promise NEVER rejects -- an unconfigured Search/Foundry, a network outage, or
 * any internal error all degrade to null exactly like "no similar incident found", never a thrown
 * error the caller has to handle.
 */
export async function matchIncident(
  text: string,
  opts?: { top?: number; threshold?: number },
): Promise<IncidentMatch | null> {
  try {
    const q = (text || '').trim();
    if (!q) return null;
    if (!searchConfigured()) return null;
    const filter = buildTypeInFilterClause(INCIDENT_TYPES);
    const res = await hybridSearch(INCIDENT_MATCH_INDEX, q, opts?.top ?? DEFAULT_TOP, { filter });
    if (!res || !res.matches.length) return null;
    return pickBestIncident(res.matches, opts?.threshold ?? DEFAULT_MIN_CONFIDENCE);
  } catch {
    return null; // FAIL-OPEN: an outage must never surface as an error to the caller.
  }
}

export type IncidentMatchMode = 'off' | 'on';

/** Parse INCIDENT_MATCH_MODE, defaulting to 'on' (fail-open toward the recall being available,
 *  mirrors AUTO_JOURNAL_MODE's parser in safety/journal.ts): garbage/unset never crashes, it just
 *  picks the safe default. Pure. */
export function parseIncidentMatchMode(value: string | undefined): IncidentMatchMode {
  const v = (value || '').trim().toLowerCase();
  return v === 'off' ? 'off' : 'on';
}

// ---- IO shell: in-memory per-process throttle (no new external store) --------------------------
// Mirrors jit-doctrine.ts's SWEEP_ABOVE / surfacedForCallerTool exactly, keyed on (caller, incident
// id) instead of (caller, tool name). See the file header for why this throttle ANNOTATES rather
// than SUPPRESSES the outcome.
const SWEEP_ABOVE = 5000;
const surfacedForCallerIncident = new Set<string>();

/**
 * Once-per-(caller, incident) throttle: the first call for a given (callerHash, incidentId) pair in
 * this process returns true (fresh); every subsequent call for the SAME pair returns false (already
 * surfaced this incident to this caller before). Best-effort: never throws (a throttle bug must
 * never affect the tool call it rides on).
 */
export function shouldSurfaceIncident(callerHash: string, incidentId: string | undefined): boolean {
  try {
    const key = `${callerHash}:${incidentId ?? ''}`;
    if (surfacedForCallerIncident.size > SWEEP_ABOVE) surfacedForCallerIncident.clear();
    if (surfacedForCallerIncident.has(key)) return false;
    surfacedForCallerIncident.add(key);
    return true;
  } catch {
    return false; // fail-open toward "fresh" -- a throttle bug must never fabricate suppression.
  }
}

export interface IncidentMatchOutcome {
  /** The best matching past incident, or null when nothing cleared the threshold (or mode is off). */
  match: IncidentMatch | null;
  mode: IncidentMatchMode;
  /** true when `match` was found but this exact (caller, incident) pair was already surfaced
   *  earlier in this process. The match is STILL returned -- see the file header's throttle note. */
  already_surfaced?: boolean;
}

/**
 * Mode-gated, throttled evaluation -- the single entry point the tool layer calls. Mirrors
 * jit-doctrine.ts's evaluateJitDoctrine(callerHash, toolName) shape: mode 'off' short-circuits
 * before any network call; any internal error degrades to {match: null, mode}. Never throws.
 */
export async function evaluateIncidentMatch(callerHash: string, text: string): Promise<IncidentMatchOutcome> {
  const mode = parseIncidentMatchMode(process.env.INCIDENT_MATCH_MODE);
  try {
    if (mode === 'off') return { match: null, mode };
    const match = await matchIncident(text);
    if (!match) return { match: null, mode };
    if (!shouldSurfaceIncident(callerHash, match.id)) return { match, mode, already_surfaced: true };
    return { match, mode };
  } catch {
    return { match: null, mode };
  }
}

/** Test seam: forget all incident-match throttle bookkeeping so one test never sees another test's
 *  state. Mirrors jit-doctrine.ts's __resetJitDoctrineState. */
export function __resetIncidentMatchState(): void {
  surfacedForCallerIncident.clear();
}
