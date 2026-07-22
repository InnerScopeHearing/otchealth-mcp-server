/**
 * Gateway-level Content Safety AUTO-GUARD. Runs Prompt Shields on inbound tool-call args,
 * groundedness on outbound results, and Prompt Shields' document-injection scan on retrieved content
 * that is about to be concatenated into a downstream synthesis prompt, ALL AUTOMATICALLY, instead of
 * relying on agents to call the opt-in shield_check / groundedness_check tools. Wired once into the
 * registerTool wrapper (registry.ts) for the first two; the third is called directly by the one
 * retrieval path that synthesizes over retrieved passages (memory/deep-retrieval.ts).
 *
 * DESIGN (why it is shaped this way):
 *  - Modes are read FRESH from process.env per call (same pattern as compliance/guardrail.ts and the
 *    charter enforcer), so behavior can be flipped by an env change with no redeploy of code:
 *      SHIELD_MODE            off | report(default) | enforce
 *      GROUNDEDNESS_MODE      off(default) | report | enforce
 *      RETRIEVAL_SHIELD_MODE  off | report(default) | enforce
 *    off = never call the API. report = call + annotate + telemetry, NEVER block. enforce = block.
 *  - FAIL-OPEN end to end: any error (Content Safety down/slow/misconfigured) degrades to "ran:false,
 *    not blocked". A safety dependency must never take the whole gateway down. shieldPrompt/
 *    detectGroundedness already graceful-skip when CONTENT_SAFETY_* is unset (raw.skipped), so this is
 *    inert until the keys are injected — a safe rollout.
 *  - Prompt Shields is UNIVERSAL: injection can hide in any string arg, so inbound scans a bounded
 *    concatenation of the string leaves of the tool args. Groundedness is NOT universal: the Azure API
 *    needs (query, text, groundingSources), so it only runs when a tool SURFACES a grounding hint on its
 *    result (payload.groundedness). Blanket groundedness on arbitrary tool output would be meaningless.
 *  - enforce blocking is asymmetric by necessity: inbound shield blocks BEFORE the handler runs (no side
 *    effect yet, safe for any category). Outbound groundedness only enforce-blocks READ tools — a write
 *    already executed its side effect by the time we could inspect its output, so blocking then is wrong.
 *    Retrieval-shield enforce is asymmetric too, but in a different way: it never blocks the retrieval
 *    itself (the read tool still returns its raw passages), only the LLM-authored synthesis over them.
 *    See retrievalShield's own doc comment for why.
 */
import { shieldPrompt, detectGroundedness } from './content-safety.js';

export type GuardMode = 'off' | 'report' | 'enforce';

// Tools that ARE the Content Safety checks; never auto-guard them (redundant + avoids self-recursion).
const SELF_TOOLS = new Set(['shield_check', 'groundedness_check', 'claims_check']);
// Upper bound on text sent to Content Safety per call (latency + payload cap; injection markers are
// short, so a generous head is enough to catch them without shipping megabytes to the API).
export const MAX_SCAN_CHARS = 20000;
// Upper bound on how many retrieved documents a single retrievalShield() call scans. Callers already
// bound how many passages reach a synthesis prompt (e.g. deep-retrieval's MAX_SYNTH_HITS), so this is
// a defensive second bound, not the primary control.
export const MAX_RETRIEVAL_DOCS = 20;

/** Parse a mode env var to off|report|enforce, defaulting defensively. Pure. */
export function parseMode(value: string | undefined, fallback: GuardMode): GuardMode {
  const v = (value || '').trim().toLowerCase();
  return v === 'off' || v === 'report' || v === 'enforce' ? v : fallback;
}

/** Concatenate the string leaves of an arbitrary args object, bounded to `max` chars. Pure/testable. */
export function collectArgText(args: unknown, max: number = MAX_SCAN_CHARS): string {
  const parts: string[] = [];
  let len = 0;
  const walk = (v: unknown): void => {
    if (len >= max) return;
    if (typeof v === 'string') {
      parts.push(v);
      len += v.length;
    } else if (Array.isArray(v)) {
      for (const x of v) walk(x);
    } else if (v && typeof v === 'object') {
      for (const x of Object.values(v as Record<string, unknown>)) walk(x);
    }
  };
  walk(args);
  return parts.join('\n').slice(0, max);
}

function configured(raw: unknown): boolean {
  return !(raw && typeof raw === 'object' && (raw as { skipped?: unknown }).skipped);
}

export interface ShieldOutcome {
  ran: boolean;
  attackDetected: boolean;
  blocked: boolean;
  mode: GuardMode;
  detail?: { userPromptAttack: boolean; documentsAttack: boolean };
}

/**
 * Inbound Prompt Shields on tool-call args. Returns blocked=true ONLY when SHIELD_MODE=enforce AND an
 * attack was detected; the caller must then refuse the tool BEFORE running its handler. report mode sets
 * attackDetected but blocked=false (annotate + log, never block). Fail-open: any throw -> ran:false.
 */
export async function inboundShield(toolName: string, args: unknown): Promise<ShieldOutcome> {
  const mode = parseMode(process.env.SHIELD_MODE, 'report');
  if (mode === 'off' || SELF_TOOLS.has(toolName)) {
    return { ran: false, attackDetected: false, blocked: false, mode };
  }
  const text = collectArgText(args);
  if (!text.trim()) return { ran: false, attackDetected: false, blocked: false, mode };
  try {
    const r = await shieldPrompt(text);
    if (!configured(r.raw)) return { ran: false, attackDetected: false, blocked: false, mode };
    return {
      ran: true,
      attackDetected: r.attackDetected,
      blocked: mode === 'enforce' && r.attackDetected,
      mode,
      detail: r.attackDetected
        ? { userPromptAttack: r.userPromptAttack, documentsAttack: r.documentsAttack }
        : undefined,
    };
  } catch {
    return { ran: false, attackDetected: false, blocked: false, mode }; // fail-open
  }
}

/** Grounding hint a tool can surface on its result to opt into an automatic outbound groundedness check. */
export interface GroundingHint {
  query: string;
  text: string;
  groundingSources: string[];
}

export interface GroundednessOutcome {
  ran: boolean;
  ungroundedDetected: boolean;
  ungroundedPercentage: number;
  blocked: boolean;
  mode: GuardMode;
}

/**
 * Outbound groundedness on a tool result, driven by a grounding hint the tool surfaced. Runs only when
 * GROUNDEDNESS_MODE != off AND the hint carries text + at least one grounding source (the API needs
 * sources; without them groundedness is undefined, so we skip). `enforceEligible` gates enforce-blocking
 * to read-only tools (a write already executed; blocking its output is pointless). Fail-open.
 */
export async function outboundGroundedness(
  hint: GroundingHint | undefined,
  enforceEligible: boolean,
): Promise<GroundednessOutcome> {
  const mode = parseMode(process.env.GROUNDEDNESS_MODE, 'off');
  if (
    mode === 'off' ||
    !hint ||
    typeof hint.text !== 'string' ||
    !hint.text.trim() ||
    !Array.isArray(hint.groundingSources) ||
    hint.groundingSources.length === 0
  ) {
    return { ran: false, ungroundedDetected: false, ungroundedPercentage: 0, blocked: false, mode };
  }
  try {
    const r = await detectGroundedness(hint.query || '', hint.text, hint.groundingSources);
    if (!configured(r.raw)) {
      return { ran: false, ungroundedDetected: false, ungroundedPercentage: 0, blocked: false, mode };
    }
    return {
      ran: true,
      ungroundedDetected: r.ungroundedDetected,
      ungroundedPercentage: r.ungroundedPercentage,
      blocked: mode === 'enforce' && enforceEligible && r.ungroundedDetected,
      mode,
    };
  } catch {
    return { ran: false, ungroundedDetected: false, ungroundedPercentage: 0, blocked: false, mode }; // fail-open
  }
}

export interface RetrievalShieldOutcome {
  ran: boolean;
  /** True when Prompt Shields flagged an injection attempt INSIDE one of the scanned documents, as
   *  opposed to the query itself. See retrievalShield's own doc comment below for the distinction. */
  attackDetected: boolean;
  blocked: boolean;
  mode: GuardMode;
  /** How many documents were actually sent to the scan (after filtering/bounding), 0 when not ran. */
  scannedCount: number;
}

/**
 * Content-level Prompt Shields scan for the INDIRECT prompt-injection vector: a malicious instruction
 * hidden INSIDE a retrieved document (a legal filing, an email, a memory entry) that a downstream
 * synthesis LLM call could otherwise treat as a real instruction rather than as reference material to
 * quote or describe. This is a different vector from inboundShield above, which scans the CALLER's own
 * tool-call arguments, not content the gateway itself retrieved and is about to hand to an LLM.
 *
 * Uses Prompt Shields' own `documents` parameter (shieldPrompt's second argument). The Content Safety
 * API is explicitly designed to classify each supplied document independently for this exact indirect
 * injection pattern, distinct from the `userPrompt` (here, the retrieval query) classification.
 *
 * Call this with the EXACT passages that are about to be concatenated into a synthesis prompt (e.g.
 * memory/deep-retrieval.ts's final, retraction-filtered `hits`, right before buildSynthesisMessages),
 * so what is scanned is what is actually sent to the LLM, not some earlier, larger candidate pool.
 *
 * Mode: RETRIEVAL_SHIELD_MODE off | report(default) | enforce, the same off/report/enforce convention
 * as SHIELD_MODE/GROUNDEDNESS_MODE, read fresh from process.env so it can flip without a redeploy.
 * report annotates only (never withholds synthesis). enforce signals the caller to withhold the
 * SYNTHESIS step, never the retrieval itself: the underlying passages are still returned to the caller
 * (brain_search stays read-only and transparent about what it found), only the LLM-authored narrative
 * built from them is withheld, since blocking a whole read tool over content it merely quotes back would
 * be disproportionate and would hide the very passages a human might want to review. Fail-open: any
 * Content Safety error, or an unconfigured endpoint/key, degrades to ran:false and never throws. A
 * safety dependency must never break retrieval.
 */
export async function retrievalShield(query: string, documents: string[]): Promise<RetrievalShieldOutcome> {
  const mode = parseMode(process.env.RETRIEVAL_SHIELD_MODE, 'report');
  const scanned = (Array.isArray(documents) ? documents : [])
    .filter((d): d is string => typeof d === 'string' && d.trim().length > 0)
    .slice(0, MAX_RETRIEVAL_DOCS)
    .map((d) => d.slice(0, MAX_SCAN_CHARS));

  if (mode === 'off' || scanned.length === 0) {
    return { ran: false, attackDetected: false, blocked: false, mode, scannedCount: 0 };
  }
  try {
    const r = await shieldPrompt((query || '').slice(0, MAX_SCAN_CHARS), scanned);
    if (!configured(r.raw)) {
      return { ran: false, attackDetected: false, blocked: false, mode, scannedCount: 0 };
    }
    return {
      ran: true,
      attackDetected: r.documentsAttack,
      blocked: mode === 'enforce' && r.documentsAttack,
      mode,
      scannedCount: scanned.length,
    };
  } catch {
    return { ran: false, attackDetected: false, blocked: false, mode, scannedCount: 0 }; // fail-open
  }
}
