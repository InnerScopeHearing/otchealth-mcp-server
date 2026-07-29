/**
 * CAPTURE-PRESSURE NUDGE — tracks, per bearer identity, how many mutating tool calls have
 * happened since the last checkpoint() call, and attaches a non-fatal nudge once a threshold is
 * crossed. Sibling to safety/cold-start.ts (same pure-core + thin-IO-shell shape, same in-memory
 * per-process Map, same fail-open-by-construction guarantee) but answers a different question:
 * cold-start asks "did you orient at the START of this session," capture-pressure asks "are you
 * about to lose everything you did DURING it." Wired once into the registerTool wrapper
 * (registry.ts), at the SAME seam that fires the auto-journal (safety/journal.ts).
 *
 *  - CAPTURE_MODE is read FRESH from process.env per call (off | warn (default)), same reasoning
 *    as COLD_START_MODE/SHIELD_MODE/GROUNDEDNESS_MODE (config/env.ts): flip by env change, no
 *    redeploy. There is no 'enforce' mode -- capture-pressure is ALWAYS advisory. A lost episode
 *    is recoverable from the auto-journal itself; refusing a tool call over a soft nudge would be
 *    a worse outcome than the thing it is trying to prevent.
 *  - CRITICAL fail-open: an unavailable identity, or any internal error, never affects the tool
 *    call. recordMutation / recordCheckpoint / evaluateCapturePressure never throw.
 *  - Reads are never counted -- the call site in registry.ts only calls recordMutation under the
 *    SAME `def.category !== 'read' && !dryRun` gate the auto-journal uses.
 *  - No new external store: an in-memory Map, per gateway process. A process restart forgets
 *    every counter (everyone reads as 0 mutations again) -- acceptable for a soft nudge. The
 *    gateway runs 2-10 replicas behind the load balancer, so this counter is PER-REPLICA, not a
 *    true global session count: a caller whose calls land on different replicas will see the
 *    threshold take longer to trip than its real call count. Acceptable for an advisory nudge
 *    (never a correctness guarantee) -- the durable signal is the episodes themselves in Cosmos,
 *    not this counter. Same caveat safety/cold-start.ts documents for its own wake-tracking Map.
 *
 * Split into a PURE decision core (computeCapturePressureOutcome — no IO, no Map) and a thin IO
 * shell (recordMutation / recordCheckpoint / evaluateCapturePressure) that owns the Map, mirroring
 * cold-start.ts's computeColdStartOutcome / markWoken / evaluateColdStart split.
 */

export type CaptureMode = 'off' | 'warn';

/** Default CAPTURE_PRESSURE_THRESHOLD when unset or invalid. Raised from 10 to 50 on 2026-07-29
 *  (FND: a real CFO session observed 49 mutations in one substantive session against a threshold
 *  of 10, i.e. ~5x over on ordinary work, not an outlier) -- there is no enforce mode (see module
 *  header), so this only changes how early the advisory nudge fires, never blocks anything. */
export const DEFAULT_CAPTURE_THRESHOLD = 50;

export interface CapturePressureOutcome {
  /** True ONLY when a nudge should be attached (mutations >= threshold AND mode 'warn'). */
  nudge: boolean;
  mutations: number;
  threshold: number;
  mode: CaptureMode;
}

/** Parse CAPTURE_MODE, defaulting to 'warn' on garbage/unset input (fail-open toward visibility,
 *  mirrors parseColdStartMode). Pure. */
export function parseCaptureMode(value: string | undefined): CaptureMode {
  const v = (value || '').trim().toLowerCase();
  return v === 'off' ? 'off' : 'warn';
}

/** Parse CAPTURE_PRESSURE_THRESHOLD, defaulting to DEFAULT_CAPTURE_THRESHOLD on garbage/unset/
 *  non-positive input. Pure. */
export function parseCaptureThreshold(value: string | undefined): number {
  const n = Number.parseInt((value ?? '').trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_CAPTURE_THRESHOLD;
}

/**
 * Pure decision core: given the mode, the current mutation count, and the threshold, decide
 * whether to nudge. No IO, no Map, no clock — fully deterministic and unit-testable at the exact
 * boundary (threshold-1 vs threshold vs threshold+1).
 */
export function computeCapturePressureOutcome(
  mode: CaptureMode,
  mutations: number,
  threshold: number,
): CapturePressureOutcome {
  if (mode === 'off') return { nudge: false, mutations, threshold, mode };
  return { nudge: mutations >= threshold, mutations, threshold, mode };
}

/**
 * Verbatim nudge-line builder. No em/en dashes (published-string rule). "0 checkpoints" is always
 * literally accurate at nudge time: recordCheckpoint() resets `mutations` to 0, so a nudge
 * (mutations >= threshold) can only fire in a streak where zero checkpoints have happened since
 * the counter was last reset — it is a true statement about THIS streak, not a hardcoded lifetime
 * count of zero.
 */
export function buildCaptureNudgeMessage(mutations: number): string {
  return `CAPTURE_PRESSURE: ${mutations} mutations this session, 0 checkpoints. Call checkpoint(agent) to distill and persist, or this context dies at compaction.`;
}

// ---- IO shell: in-memory per-process tracking (no new external store) --------------------------

interface CaptureState {
  mutations: number;
  checkpoints: number;
  lastNudgeAt: number | null;
}

// Mirrors cold-start.ts's SWEEP_ABOVE: bound the Map's memory footprint across a long-running
// process without a background timer. Capture-pressure state has no natural TTL (unlike wake,
// which expires after WAKE_TTL_MS), so instead of a time-based sweep this does a full reset once
// the distinct-caller count gets implausibly large — rare in practice (one entry per distinct
// bearer identity), and the worst case is a caller's streak restarts at 0, a no-op for a soft,
// advisory nudge.
const SWEEP_ABOVE = 5000;

const stateByCaller = new Map<string, CaptureState>();

function getOrCreate(identity: string): CaptureState {
  let s = stateByCaller.get(identity);
  if (!s) {
    if (stateByCaller.size > SWEEP_ABOVE) stateByCaller.clear();
    s = { mutations: 0, checkpoints: 0, lastNudgeAt: null };
    stateByCaller.set(identity, s);
  }
  return s;
}

/** Record one mutating tool call for `identity`. Best-effort: never throws. */
export function recordMutation(identity: string): void {
  try {
    if (!identity) return;
    getOrCreate(identity).mutations += 1;
  } catch {
    /* best-effort bookkeeping only */
  }
}

/** Record a checkpoint() call for `identity`: bumps the checkpoint count and resets the mutation
 *  streak to 0 (checkpointing IS the act that relieves capture pressure). Best-effort: never
 *  throws, so a checkpoint tool failure elsewhere can never be caused by this bookkeeping. */
export function recordCheckpoint(identity: string): void {
  try {
    if (!identity) return;
    const s = getOrCreate(identity);
    s.checkpoints += 1;
    s.mutations = 0;
  } catch {
    /* best-effort bookkeeping only */
  }
}

/**
 * Evaluate capture pressure for `identity`. CRITICAL fail-open: an unavailable identity, or any
 * internal error, returns nudge:false rather than ever throwing or affecting the caller.
 */
export function evaluateCapturePressure(identity: string): CapturePressureOutcome {
  const mode = parseCaptureMode(process.env.CAPTURE_MODE);
  const threshold = parseCaptureThreshold(process.env.CAPTURE_PRESSURE_THRESHOLD);
  try {
    if (!identity) return { nudge: false, mutations: 0, threshold, mode };
    const s = stateByCaller.get(identity);
    const mutations = s?.mutations ?? 0;
    const outcome = computeCapturePressureOutcome(mode, mutations, threshold);
    if (outcome.nudge && s) s.lastNudgeAt = Date.now();
    return outcome;
  } catch {
    return { nudge: false, mutations: 0, threshold, mode };
  }
}

/** Test seam: forget all capture-pressure bookkeeping so one test never sees another test's state. */
export function __resetCapturePressureState(): void {
  stateByCaller.clear();
}
