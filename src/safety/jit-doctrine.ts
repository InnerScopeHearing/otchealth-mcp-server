/**
 * JIT DOCTRINE — binds a known, ledgered pitfall to the exact tool it applies to, and surfaces it
 * at the moment of USE rather than only at session start. Phase 1 (#109) shipped doctrine-at-wake:
 * `wake` returns definition_of_done + pitfalls + standing_directives once, at the top of a session.
 * That is necessary but not sufficient — a pitfall read at wake and then forgotten forty tool calls
 * later provides no protection at the point of exposure. JIT doctrine v1 closes that gap: when an
 * agent calls a tool that has a pitfall bound to it, that pitfall rides along on THIS call's
 * response, right when it is actionable. Sibling to safety/cold-start.ts and
 * safety/capture-pressure.ts (same pure-core + thin-IO-shell shape, same in-memory per-process
 * state, same fail-open-by-construction guarantee) but answers a third, different question:
 * cold-start asks "did you orient at the START of this session," capture-pressure asks "are you
 * about to lose everything you did DURING it," jit-doctrine asks "do you know the sharp edge on
 * the tool you are about to call RIGHT NOW." Wired once into the registerTool wrapper
 * (registry.ts), at the same seam that composes the cold-start / capture-pressure prelude lines.
 *
 *  - JIT_DOCTRINE_MODE is read FRESH from process.env per call (off | warn (default)), same
 *    reasoning as COLD_START_MODE/CAPTURE_MODE (config/env.ts): flip by env change, no redeploy.
 *    There is no 'enforce' mode in v1 -- jit-doctrine is ALWAYS advisory, exactly like
 *    capture-pressure. A missed pitfall warning is a worse-informed call, not an unsafe one to
 *    refuse outright; the binding table itself is the mitigation, not a gate.
 *  - CRITICAL fail-open: an unavailable identity, an unrecognized tool, or any internal error
 *    NEVER affects the tool call and NEVER throws. jitDoctrineFor / evaluateJitDoctrine /
 *    shouldSurfaceDoctrine all degrade to "no doctrine attached" on any doubt, mirroring how
 *    evaluateColdStart / evaluateCapturePressure degrade to "no warning" rather than ever letting
 *    an advisory nudge become the reason a call fails or slows down.
 *  - Evaluated for EVERY tool call (read AND write), unlike cold-start/capture-pressure which only
 *    apply to mutating (non-'read') categories. A pitfall bound to a READ tool (e.g. a PostHog read
 *    defaulting to the PHI project, or a legal_blob_get reaching into the privileged personal room)
 *    is exactly the moment the agent needs the warning -- gating this on category would silently
 *    drop the read-tool bindings the seed table actually needs (posthog_, legal_blob_,
 *    kb_search_privileged). registry.ts calls evaluateJitDoctrine() unconditionally in the success
 *    path, not inside the `def.category !== 'read'` block.
 *  - No new external store: an in-memory Set, per gateway process, keyed on `${callerHash}:
 *    ${toolName}`, cleared wholesale once it grows implausibly large (mirrors capture-pressure.ts's
 *    SWEEP_ABOVE clear; jit-doctrine bindings have no natural TTL the way wake does). A process
 *    restart forgets every "already told this caller" entry (everyone reads as never-told again)
 *    -- acceptable for a soft nag-reducer, never a hard dependency. The gateway runs 2-10 replicas
 *    behind the load balancer, so this throttle is PER-REPLICA: a caller whose calls land on
 *    different replicas may see the same pitfall surfaced more than once. Acceptable for an
 *    advisory nudge (never a correctness guarantee), same caveat cold-start.ts and
 *    capture-pressure.ts document for their own per-process Maps.
 *
 * Split into a PURE decision core (jitDoctrineFor -- no IO, no Set, no clock; a straight lookup
 * over static data) and a thin IO shell (shouldSurfaceDoctrine / evaluateJitDoctrine) that owns the
 * Set and reads process.env, mirroring cold-start.ts's computeColdStartOutcome / markWoken /
 * evaluateColdStart split and capture-pressure.ts's computeCapturePressureOutcome /
 * recordMutation+recordCheckpoint / evaluateCapturePressure split.
 */

export type JitDoctrineMode = 'off' | 'warn';

/** How a binding's `match` is compared against the incoming tool name. */
export type JitBindingKind = 'exact' | 'prefix';

export interface JitDoctrineBinding {
  /** A tool name (kind:'exact') or a tool-name prefix (kind:'prefix', e.g. 'n8n_'). */
  match: string;
  kind: JitBindingKind;
  /** One or more short, verbatim pitfall lines. No em/en dashes (published-string rule). */
  pitfalls: string[];
}

/**
 * The binding table. Pure data on purpose -- a future pitfall is a one-line addition here, no
 * other code changes. Real, ledgered pitfalls pulled from the fleet's operating record (see
 * otchealth-cto/CLAUDE.md and otchealth-claude-tools/CLAUDE.md for the source facts each of these
 * condenses). Exact bindings match a full tool name; prefix bindings match a whole service surface
 * (e.g. every n8n_* tool) with one entry instead of one per tool.
 */
export const JIT_DOCTRINE_BINDINGS: JitDoctrineBinding[] = [
  {
    match: 'azure_containerapp_set_env',
    kind: 'exact',
    pitfalls: [
      'Overwriting the gateway inline oauth-clients secret with a partial registry silently drops all connector clients and causes a fleet-wide connector outage. Reconcile against the live inline secret first; never replace it wholesale.',
    ],
  },
  {
    match: 'azure_job_execute',
    kind: 'exact',
    pitfalls: [
      'Run doc-indexer jobs only on the fully skew-proof image. Concurrent jobs on an older image do non-additive writes and corrupt the index.',
    ],
  },
  {
    match: 'azure_job_upsert',
    kind: 'exact',
    pitfalls: [
      'Container Apps Job args must be a proper array, not one comma-joined token, or /bin/sh cannot find the script and the run fails instantly.',
    ],
  },
  {
    match: 'n8n_',
    kind: 'prefix',
    pitfalls: [
      'n8n Cloud (otchealth.app.n8n.cloud) is decommissioned. Target the self-host automation.otchealth.app only. PHI flows run ONLY on the self-host.',
    ],
  },
  {
    match: 'posthog_',
    kind: 'prefix',
    pitfalls: [
      'The active PostHog project can default to MedReview (PHI) project 468398. Confirm a NON-PHI project before any write.',
    ],
  },
  {
    match: 'llm_azure',
    kind: 'exact',
    pitfalls: [
      'gpt-4.1-mini is banned for quality summarization; it degrades output. Use gpt-4o or the standard tier for summarization-quality-sensitive work.',
    ],
  },
  {
    match: 'legal_blob_',
    kind: 'prefix',
    pitfalls: [
      'legal-personal is privileged, CLO-only, and never co-mingled with company legal. Never export privileged content to a shared or unauthorized destination.',
    ],
  },
  {
    match: 'kb_search_privileged',
    kind: 'exact',
    pitfalls: [
      'This reads privileged rooms. Do not route its results to any non-privileged or external destination.',
    ],
  },
  {
    match: 'depot_trigger_build',
    kind: 'exact',
    pitfalls: [
      'iOS builds must use runner depot-macos-26 (Xcode 26) or altool 409-rejects the upload. Depot ephemeral runners mint throwaway Apple dev certs each build and hit Apple cert cap; revoke stale Created-via-API dev certs.',
    ],
  },
  {
    match: 'shopify_create_product',
    kind: 'exact',
    pitfalls: [
      'TReO is a PSAP, not a hearing aid. Listing copy carries zero hearing-aid, medical, or FDA language, and routes through the compliance lane before publishing.',
    ],
  },
  {
    match: 'memory_write',
    kind: 'exact',
    pitfalls: [
      'Set supersedes when this entry makes a prior one FALSE (not merely related), so the retracted belief is dropped and cannot resurface as a live truth.',
    ],
  },
  {
    match: 'memory_remember',
    kind: 'exact',
    pitfalls: [
      'Set supersedes when this corrects a prior fact, so the stale belief is dropped from wake and memory_pack.',
    ],
  },
];

/**
 * Pure decision core: given a tool name, return the concatenated pitfalls for every binding that
 * matches it (exact match, or prefix match when kind==='prefix'). A tool can match more than one
 * binding (e.g. a hypothetical future exact binding on a name that also matches a prefix binding);
 * all matching pitfalls are concatenated in table order. No IO, no Set, no clock, no process.env --
 * fully deterministic and unit-testable. Empty array when nothing matches. Never throws (a missing
 * or empty toolName just yields no matches).
 */
export function jitDoctrineFor(toolName: string): string[] {
  if (!toolName) return [];
  const pitfalls: string[] = [];
  for (const binding of JIT_DOCTRINE_BINDINGS) {
    const hit =
      binding.kind === 'exact' ? toolName === binding.match : toolName.startsWith(binding.match);
    if (hit) pitfalls.push(...binding.pitfalls);
  }
  return pitfalls;
}

/** Parse JIT_DOCTRINE_MODE, defaulting to 'warn' on garbage/unset input (fail-open toward
 *  visibility, mirrors parseCaptureMode). Pure. No 'enforce' mode exists in v1. */
export function parseJitDoctrineMode(value: string | undefined): JitDoctrineMode {
  const v = (value || '').trim().toLowerCase();
  return v === 'off' ? 'off' : 'warn';
}

export interface JitDoctrineOutcome {
  /** Pitfalls to attach to THIS response. Empty when off, no binding matches, or already surfaced
   *  to this (caller, tool) pair in this process. */
  pitfalls: string[];
  mode: JitDoctrineMode;
}

// ---- IO shell: in-memory per-process throttle (no new external store) --------------------------

// Mirrors cold-start.ts's SWEEP_ABOVE / capture-pressure.ts's SWEEP_ABOVE: bound the Set's memory
// footprint across a long-running process without a background timer. jit-doctrine throttle state
// has no natural TTL (unlike wake, which expires after WAKE_TTL_MS), so instead of a time-based
// sweep this does a full clear once the distinct (caller, tool) pair count gets implausibly large --
// rare in practice, and the worst case is a caller/tool pair's "already told" state resets, a no-op
// for a soft, advisory throttle (the pitfall just gets surfaced one more time than strictly needed).
const SWEEP_ABOVE = 5000;

const surfacedForCallerTool = new Set<string>();

/**
 * Thin once-per-(caller,tool)-per-process throttle: the first call for a given (callerHash,
 * toolName) pair in this process returns true (surface it); every subsequent call for the SAME
 * pair returns false (already told this caller about this tool, do not nag). Keying naturally
 * degrades for a missing identity/tool name (an empty string is just another Set key), so no
 * special-casing is needed there -- unlike cold-start/capture-pressure, whose signal IS per-identity
 * session state, jit-doctrine's pitfall text is static tool-bound data and this throttle is purely
 * a nagging-reducer, not a correctness gate. Best-effort: never throws.
 */
export function shouldSurfaceDoctrine(callerHash: string, toolName: string): boolean {
  try {
    const key = `${callerHash}:${toolName}`;
    if (surfacedForCallerTool.size > SWEEP_ABOVE) surfacedForCallerTool.clear();
    if (surfacedForCallerTool.has(key)) return false;
    surfacedForCallerTool.add(key);
    return true;
  } catch {
    return false; // fail-open toward silence: a throttle bug must never force-inject content
  }
}

/**
 * Evaluate JIT doctrine for a tool call. CRITICAL fail-open (per the standing directive): mode
 * 'off', no matching binding, an already-surfaced (caller, tool) pair, or any internal error all
 * return an empty pitfalls array rather than ever throwing or affecting the caller. Called for
 * EVERY tool category (read and write) -- see the module doc comment for why this deliberately
 * does NOT mirror cold-start/capture-pressure's `def.category !== 'read'` gate.
 */
export function evaluateJitDoctrine(callerHash: string, toolName: string): JitDoctrineOutcome {
  const mode = parseJitDoctrineMode(process.env.JIT_DOCTRINE_MODE);
  try {
    if (mode === 'off') return { pitfalls: [], mode };
    const pitfalls = jitDoctrineFor(toolName);
    if (!pitfalls.length) return { pitfalls: [], mode };
    if (!shouldSurfaceDoctrine(callerHash, toolName)) return { pitfalls: [], mode };
    return { pitfalls, mode };
  } catch {
    return { pitfalls: [], mode };
  }
}

/** Test seam: forget all jit-doctrine throttle bookkeeping so one test never sees another test's
 *  state. */
export function __resetJitDoctrineState(): void {
  surfacedForCallerTool.clear();
}
