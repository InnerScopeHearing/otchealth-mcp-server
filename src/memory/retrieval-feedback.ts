/**
 * RETRIEVAL FEEDBACK -- the production feedback loop's capture plane (Wave 7 item 7.1). Lets a
 * caller of brain_search / kb_search report, after the fact, whether a specific returned hit was
 * actually useful, so future recall-quality work has real signal to consume beyond the static
 * eval suites (see skills/agent-evals, skills/recall-evals).
 *
 * ============================ SHAPE (mirrors safety/journal.ts) ============================
 * A PURE core (buildFeedbackRef / parseFeedbackRef / isFeedbackRating / buildFeedbackEventProperties)
 * with no IO, no clock (the caller supplies `now`), no network -- fully unit-testable without
 * PostHog or a live gateway. A thin IO shell (recordRetrievalFeedback) that owns the actual
 * captureGatewayEvent call, EXTENDING the exact same fire-and-forget capture plane the Phase 2
 * auto-journal (safety/journal.ts, gw_mutation) and checkpoint (tools/memory/checkpoint.ts,
 * gw_checkpoint) already use, rather than inventing a new capture mechanism.
 *
 * ============================ THE TWO-STEP FLOW ============================
 *  (1) TAG (this file's `tagWithFeedbackRefs`, called from kb/search.ts and kb/brain-search.ts):
 *      every hit returned by a brain_search/kb_search call gets a `feedback_ref` field -- an
 *      OPAQUE, SELF-DESCRIBING token that encodes {tool, room, hitId, query, ts}. Building it is
 *      pure and synchronous (base64url of a small JSON object); there is no write, no network call,
 *      and no dependency on any store at tag time. This is what keeps retrieval itself
 *      unconditionally fast: tagging can never fail, block, or depend on anything external.
 *  (2) REPORT (the new `retrieval_feedback` tool, tools/memory/retrieval-feedback.ts): a caller
 *      that later acts on (or ignores) a tagged hit passes its `feedback_ref` back with a rating.
 *      The tool decodes the ref (no re-sent content needed -- everything the analysis needs was
 *      already embedded at tag time) and fires a best-effort `gw_retrieval_feedback` PostHog event
 *      via the SAME captureGatewayEvent() fire-and-forget path gw_mutation/gw_checkpoint use.
 *
 * ============================ WHY POSTHOG, NOT COSMOS ============================
 * Feedback rows are structured, low-cardinality TELEMETRY (which tool, which room, useful or not,
 * counted and sliced over time) -- exactly the shape gw_mutation/gw_checkpoint/gw_doctrine_surfaced
 * already are, and exactly what the Gateway Ops PostHog project (493944) exists to hold and let a
 * dashboard/insight aggregate. It is NOT durable "memory of record" content that needs to be
 * semantically searchable or re-surfaced verbatim (that is what agentstate/memory.ts + Cosmos +
 * Azure AI Search are for, e.g. safety/journal.ts's episodes). Reusing the established telemetry
 * plane means zero new infrastructure, zero new fail-open contract to invent, and the existing
 * SLO/dashboard tooling (see the Phase 2 SLO comments in telemetry/gateway-ops.ts) is the natural
 * home for a future "useful-rate per room / per tool" consumption pass.
 *
 * ============================ FAIL-OPEN, NEVER BLOCK, ZERO RISK TO RETRIEVAL ============================
 * Tagging (step 1) touches brain_search/kb_search's hot path but is pure/synchronous -- it cannot
 * add latency or fail. Recording (step 2) lives entirely inside the OPT-IN retrieval_feedback tool,
 * which nothing else calls or depends on; recordRetrievalFeedback wraps captureGatewayEvent (itself
 * already fire-and-forget and non-throwing) in one more try/catch as defense in depth, matching the
 * repo's existing convention (see journal.ts's header and its call site's `.catch()`).
 *
 * ============================ NOT CONTENT, NOT A SECRET ============================
 * The ref carries only a tool name, a room/index name, a doc id, and a caller-truncated slice of the
 * ORIGINAL query text -- never the hit's retrieved text/content. It grants no access on its own (the
 * retrieval_feedback tool only ever WRITES a telemetry event from whatever a valid ref decodes to;
 * it never re-queries or re-serves privileged content), so a forged or replayed ref's worst case is
 * a bogus feedback row, not a privilege escalation.
 */
import { captureGatewayEvent } from '../telemetry/gateway-ops.js';
import { looksLikeSecretValue } from '../safety/journal.js';
import { evaluateBroadcastMnpiGate } from '../safety/mnpi-gate.js';

// ---- pure core: the reference id --------------------------------------------------------------

export const REFERENCE_PREFIX = 'rf1_';

/** Caps on what gets embedded in a reference id, so it stays small and never carries hit content. */
export const MAX_QUERY_CHARS = 120;
export const MAX_HITID_CHARS = 200;
export const MAX_ROOM_CHARS = 80;
export const MAX_TOOL_CHARS = 60;
/** Hard cap on an INCOMING ref string before attempting to decode it (defensive: never JSON.parse
 *  an arbitrarily large caller-supplied blob). Generous relative to a real ref's actual size. */
export const MAX_REF_INPUT_CHARS = 4000;

/** "Short-lived": the default window a ref is considered fresh for. Informational only (see
 *  buildFeedbackEventProperties's `ref_fresh` field) -- an aged ref is still recorded, never
 *  refused, so a slow downstream action never loses its feedback signal. */
export const DEFAULT_REF_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export interface ReferenceFields {
  /** Which tool produced this hit: 'brain_search' or 'kb_search'. */
  tool: string;
  /** The index/room the hit came from (e.g. "memory-exec", "commons-company-journal"). */
  room: string;
  /** The hit's doc id, stringified (KbHit/FusedHit's `id` field is `unknown`). */
  hitId: string;
  /** The ORIGINAL search query, truncated -- so the feedback tool never needs it re-sent. */
  query: string;
  /** Epoch ms when this ref was minted. */
  ts: number;
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s;
}

/** Best-effort stringify of an `unknown` hit id. Never throws. */
function stringifyHitId(id: unknown): string {
  if (typeof id === 'string') return truncate(id, MAX_HITID_CHARS) || 'unknown';
  if (id === undefined || id === null) return 'unknown';
  try {
    return truncate(JSON.stringify(id), MAX_HITID_CHARS);
  } catch {
    return 'unknown';
  }
}

/**
 * Build an opaque, self-describing reference id for one retrieved hit. Pure and synchronous: no
 * IO, no network, cannot fail or block the retrieval call it rides on. `now` is caller-suppliable
 * for deterministic tests; defaults to Date.now().
 */
export function buildFeedbackRef(input: { tool: string; room: string; hitId: unknown; query: string; now?: number }): string {
  const fields: ReferenceFields = {
    tool: truncate((input.tool || 'unknown').trim(), MAX_TOOL_CHARS) || 'unknown',
    room: truncate((input.room || 'unknown').trim(), MAX_ROOM_CHARS) || 'unknown',
    hitId: stringifyHitId(input.hitId),
    query: truncate((input.query || '').trim(), MAX_QUERY_CHARS),
    ts: typeof input.now === 'number' && Number.isFinite(input.now) ? input.now : Date.now(),
  };
  const json = JSON.stringify(fields);
  const b64 = Buffer.from(json, 'utf8').toString('base64url');
  return `${REFERENCE_PREFIX}${b64}`;
}

/**
 * Decode a reference id produced by buildFeedbackRef. Returns null on ANYTHING malformed
 * (wrong prefix, bad base64, bad JSON, missing/mistyped fields, oversized input) rather than
 * throwing -- a caller passing a stale/hand-typed/garbage ref is a normal, expected outcome, not
 * a crash. Never throws.
 */
export function parseFeedbackRef(ref: unknown): ReferenceFields | null {
  try {
    if (typeof ref !== 'string' || ref.length === 0 || ref.length > MAX_REF_INPUT_CHARS) return null;
    if (!ref.startsWith(REFERENCE_PREFIX)) return null;
    const b64 = ref.slice(REFERENCE_PREFIX.length);
    if (!b64) return null;
    const json = Buffer.from(b64, 'base64url').toString('utf8');
    const parsed: unknown = JSON.parse(json);
    if (!parsed || typeof parsed !== 'object') return null;
    const p = parsed as Record<string, unknown>;
    if (
      typeof p.tool !== 'string' ||
      typeof p.room !== 'string' ||
      typeof p.hitId !== 'string' ||
      typeof p.query !== 'string' ||
      typeof p.ts !== 'number' ||
      !Number.isFinite(p.ts)
    ) {
      return null;
    }
    return { tool: p.tool, room: p.room, hitId: p.hitId, query: p.query, ts: p.ts };
  } catch {
    return null;
  }
}

/** True when `ref.ts` is within DEFAULT_REF_TTL_MS of `now` (default Date.now()). Informational
 *  only -- see the header note on why a stale ref is still recorded, never refused. Pure. */
export function isFeedbackRefFresh(ref: ReferenceFields, now: number = Date.now(), ttlMs: number = DEFAULT_REF_TTL_MS): boolean {
  return now - ref.ts <= ttlMs;
}

// ---- pure core: tagging a batch of hits --------------------------------------------------------

/**
 * Stamp a `feedback_ref` onto every hit in a results array. Pure and synchronous -- no IO, cannot
 * fail or add latency to the search call it rides on. Deliberately untyped on the hit shape
 * (`unknown` in, `unknown` out): brain_search/kb_search already treat their `matches` as
 * `unknown[]` end to end (both KbHit and FusedHit, plus brain_search's synthetic entity-answer
 * row, are structurally different shapes fused into one heterogeneous array), so this reads `id`/
 * `source` defensively at runtime rather than fighting TypeScript's structural typing over three
 * incompatible hit shapes. A non-object hit (should never happen; defensive only) is left
 * unmodified except for gaining a feedback_ref, same as everything else. Never throws.
 *
 * When a hit carries its own `source` (brain_search's FusedHit, federated across rooms) that room
 * wins; otherwise `opts.defaultRoom` is used (kb_search's KbHit never carries a per-hit room,
 * since the caller already picked a single index).
 */
export function tagWithFeedbackRefs(
  hits: readonly unknown[],
  opts: { tool: string; query: string; defaultRoom: string; now?: number },
): unknown[] {
  return hits.map((h) => {
    const obj: Record<string, unknown> = h && typeof h === 'object' && !Array.isArray(h) ? (h as Record<string, unknown>) : {};
    const source = obj.source;
    return {
      ...obj,
      feedback_ref: buildFeedbackRef({
        tool: opts.tool,
        room: (typeof source === 'string' && source.trim()) || opts.defaultRoom,
        hitId: obj.id,
        query: opts.query,
        now: opts.now,
      }),
    };
  });
}

// ---- pure core: the feedback rating + event shape ----------------------------------------------

// `as const` (not an explicit `readonly FeedbackRating[]` annotation) so this stays a literal TUPLE
// type, not a widened array -- z.enum() requires a `readonly [string, ...string[]]` tuple to infer
// a proper literal union for the wire schema; a plain `readonly string[]` array collapses zod's
// inference to `string`, silently losing type safety on `input.rating` in the tool handler.
export const FEEDBACK_RATINGS = ['useful', 'not_useful', 'cited'] as const;
export type FeedbackRating = (typeof FEEDBACK_RATINGS)[number];

/** Pure type guard, exported so the tool's zod schema and any future caller share one source of truth. */
export function isFeedbackRating(v: unknown): v is FeedbackRating {
  return typeof v === 'string' && (FEEDBACK_RATINGS as readonly string[]).includes(v);
}

export const RETRIEVAL_FEEDBACK_EVENT = 'gw_retrieval_feedback';
const MAX_REASON_CHARS = 300;

/** Redact/cap a free-text reason. Reuses journal.ts's secret-VALUE heuristic (not just a key-name
 *  check, since this is free text with no keys at all) so a caller pasting a token/credential into
 *  the reason field never lands one in PostHog. Never throws. */
export function sanitizeReason(reason: string | undefined): string | undefined {
  if (!reason) return undefined;
  const trimmed = reason.trim();
  if (!trimmed) return undefined;
  if (looksLikeSecretValue(trimmed)) return '[REDACTED]';
  return truncate(trimmed, MAX_REASON_CHARS);
}

export interface FeedbackEventProperties {
  tool: string;
  room: string;
  hit_id: string;
  query: string;
  rating: FeedbackRating;
  reason?: string;
  ref_issued_ms: number;
  ref_age_ms: number;
  ref_fresh: boolean;
  [key: string]: unknown;
}

/**
 * Pure, deterministic builder for the gw_retrieval_feedback event properties. Given the same
 * input (including the same `now`) it always produces the same output. `now` defaults to
 * Date.now() so real call sites never have to thread a clock through; tests pass it explicitly.
 */
export function buildFeedbackEventProperties(input: {
  ref: ReferenceFields;
  rating: FeedbackRating;
  reason?: string;
  now?: number;
}): FeedbackEventProperties {
  const now = typeof input.now === 'number' && Number.isFinite(input.now) ? input.now : Date.now();
  const age = Math.max(0, now - input.ref.ts);
  const props: FeedbackEventProperties = {
    tool: input.ref.tool,
    room: input.ref.room,
    hit_id: input.ref.hitId,
    query: input.ref.query,
    rating: input.rating,
    ref_issued_ms: input.ref.ts,
    ref_age_ms: age,
    ref_fresh: age <= DEFAULT_REF_TTL_MS,
  };
  const reason = sanitizeReason(input.reason);
  if (reason) props.reason = reason;
  return props;
}

// ---- IO shell -----------------------------------------------------------------------------------

export interface RecordRetrievalFeedbackResult {
  recorded: boolean;
  /** Populated only when recorded is false because the MNPI gate blocked this feedback. */
  mnpiBlockedReason?: string;
}

/**
 * Fire a best-effort `gw_retrieval_feedback` capture. FAIL-OPEN BY CONSTRUCTION: wrapped in its
 * own try/catch (defense in depth on top of captureGatewayEvent's own never-throws contract, the
 * same belt-and-suspenders convention journal.ts's call site uses). Synchronous and non-blocking:
 * captureGatewayEvent never returns a promise the caller could accidentally await-and-stall on, so
 * calling this can never add latency to the retrieval_feedback tool response.
 *
 * MNPI GATE (hard, code-level, added after this file's initial build -- see safety/mnpi-gate.ts):
 * `ref.query` is the caller's ORIGINAL search query (truncated, embedded at tag time by
 * buildFeedbackRef) and `reason` is arbitrary free text; both flow straight into a
 * gw_retrieval_feedback PostHog event in the Gateway Ops project, a non-privileged, broadly-shared
 * destination -- exactly the same "broadcast-style tool with no legitimate destination for EXEC_RING/
 * MNPI content" shape web_search / memory_remember / memory_write / checkpoint are already hard-gated
 * on. brain_search (the tool this ref usually comes from) DOES federate across ring-gated finance/
 * legal rooms for EXEC_RING lanes, so a caller's own query text can itself be MNPI/privileged (e.g.
 * "burn rate on the Series A before the public filing"), and unlike a hit's retrieved content, that
 * query text was NOT already screened by anything upstream. Scanned and hard-blocked here, before the
 * capture, for every caller including EXEC_RING -- mirrors evaluateBroadcastMnpiGate's other call
 * sites exactly. On a block, recordRetrievalFeedback returns {recorded:false, mnpiBlockedReason} so
 * the tool handler can report the truth instead of claiming a success that did not happen.
 */
export function recordRetrievalFeedback(input: {
  ref: ReferenceFields;
  rating: FeedbackRating;
  reason?: string;
  caller?: string;
  now?: number;
}): RecordRetrievalFeedbackResult {
  try {
    const gate = evaluateBroadcastMnpiGate({ query: input.ref.query, reason: input.reason });
    if (gate.blocked) {
      return { recorded: false, mnpiBlockedReason: gate.reason };
    }
    const props = buildFeedbackEventProperties(input);
    captureGatewayEvent(RETRIEVAL_FEEDBACK_EVENT, props, input.caller);
    return { recorded: true };
  } catch {
    /* FAIL-OPEN: a feedback-capture failure must be completely invisible to the caller. */
    return { recorded: true };
  }
}
