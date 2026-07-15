/**
 * COLD-START GATE — tracks, per bearer identity, whether `wake` has been called recently, and
 * nudges (warn mode) or refuses (enforce mode) a MUTATING tool call made by a session that skipped
 * it. Wired once into the registerTool wrapper (registry.ts), mirroring the safety/auto-guard.ts
 * pattern used for Prompt Shields / groundedness:
 *
 *  - COLD_START_MODE is read FRESH from process.env per call (off | warn (default) | enforce), NOT
 *    from the Zod env schema — same reasoning as SHIELD_MODE/GROUNDEDNESS_MODE (config/env.ts): it
 *    can be flipped by an env change with no code redeploy.
 *  - 'warn' (the default) ATTACHES a non-fatal warning to the response; the tool still runs.
 *    'enforce' refuses the call before the handler runs. 'off' is a full no-op.
 *  - CRITICAL fail-open: an unavailable identity, or any internal error, ALLOWS the call (never
 *    blocks on an internal error). A reliability nudge must never become an outage.
 *  - Reads are NEVER gated — the call site in registry.ts only asks this module about non-'read'
 *    tool categories; evaluateColdStart() itself doesn't need to know about categories at all.
 *  - No new external store: an in-memory Map, per gateway process, TTL ~6h. A process restart just
 *    forgets who woke (everyone reads as "cold" again) — acceptable for a soft nudge, never a hard
 *    dependency.
 *
 * Identity: callers pass the bearer identity hash (`caller_hash` from auth/bearer.ts — the SHA256
 * hash of the raw bearer token, already computed on every request and threaded into ToolContext as
 * callerHash; see server/request-context.ts). That hash IS the canonical "bearer identity" this
 * module keys on, so no new plumbing through AuthContext/OAuth claims (e.g. a jti) is required.
 *
 * Split into a PURE decision core (computeColdStartOutcome — no IO, no clock, no Map; takes an
 * explicit "now" so TTL-boundary behavior is deterministically unit-testable without waiting out a
 * real 6-hour window) and a thin IO shell (markWoken/evaluateColdStart) that owns the Map + the
 * real clock. Mirrors the "pure decision core" shape used elsewhere in the fleet (e.g. the
 * compute-allocator skill's allocateCompute).
 */

export type ColdStartMode = 'off' | 'warn' | 'enforce';

/** Verbatim user-facing nudge text. No em/en dashes (published-string rule). */
export const COLD_START_MESSAGE =
  'COLD_START: you are operating without current doctrine and state, call wake() first.';

/** ~6 hours. A session that woke more recently than this is still considered current. */
export const WAKE_TTL_MS = 6 * 60 * 60 * 1000;

export interface ColdStartOutcome {
  /** True when this call is from a session that has not woken within the TTL (mode warn or enforce). */
  cold: boolean;
  /** True ONLY when the call must be REFUSED (mode enforce AND cold). registry.ts must check this
   * before running the handler; when false the call proceeds (silently, or with a warning attached). */
  block: boolean;
  mode: ColdStartMode;
}

/** Parse COLD_START_MODE, defaulting to 'warn' per the standing directive (fail-open on garbage input). Pure. */
export function parseColdStartMode(value: string | undefined): ColdStartMode {
  const v = (value || '').trim().toLowerCase();
  return v === 'off' || v === 'warn' || v === 'enforce' ? v : 'warn';
}

/**
 * Pure decision core: given the mode, when (if ever) this identity last woke, and the current time,
 * decide whether the call is cold and whether it should be blocked. No IO, no Date.now(), no Map —
 * fully deterministic and unit-testable without waiting out the real TTL.
 */
export function computeColdStartOutcome(
  mode: ColdStartMode,
  lastWokenAtMs: number | undefined,
  nowMs: number,
): ColdStartOutcome {
  if (mode === 'off') return { cold: false, block: false, mode };
  const awake = lastWokenAtMs !== undefined && nowMs - lastWokenAtMs <= WAKE_TTL_MS;
  if (awake) return { cold: false, block: false, mode };
  return { cold: true, block: mode === 'enforce', mode };
}

// ---- IO shell: in-memory per-process tracking (no new external store) --------------------------

// Opportunistic-sweep threshold: bound the Map's memory footprint across a long-running process
// without a background timer (a timer is one more thing that can wedge a stateless-per-request
// server). Sweeping happens inline on a markWoken call once the map grows past this size.
const SWEEP_ABOVE = 5000;

const wokenAt = new Map<string, number>();

/** Drop expired entries. Cheap single pass; only invoked opportunistically from markWoken. */
function sweep(nowMs: number): void {
  for (const [id, ts] of wokenAt) {
    if (nowMs - ts > WAKE_TTL_MS) wokenAt.delete(id);
  }
}

/**
 * Record that `identity` called wake() successfully just now. Best-effort bookkeeping only: never
 * throws, so it can never disrupt the wake() call it rides on.
 */
export function markWoken(identity: string): void {
  try {
    if (!identity) return;
    const now = Date.now();
    if (wokenAt.size > SWEEP_ABOVE) sweep(now);
    wokenAt.set(identity, now);
  } catch {
    /* best-effort bookkeeping only */
  }
}

/**
 * Evaluate the cold-start gate for a MUTATING tool call. CRITICAL fail-open (per the standing
 * directive): if the identity is unavailable, or the lookup throws for any reason, ALLOW the call
 * (cold:false, block:false) rather than ever blocking on an internal error.
 */
export function evaluateColdStart(identity: string): ColdStartOutcome {
  const mode = parseColdStartMode(process.env.COLD_START_MODE);
  try {
    if (!identity) return { cold: false, block: false, mode }; // fail-open: no identity to key on
    return computeColdStartOutcome(mode, wokenAt.get(identity), Date.now());
  } catch {
    return { cold: false, block: false, mode }; // fail-open: never block on an internal error
  }
}

/** Test seam: forget all wake bookkeeping so one test never sees another test's state. */
export function __resetColdStartState(): void {
  wokenAt.clear();
}
