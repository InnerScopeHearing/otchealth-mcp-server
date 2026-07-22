/**
 * MNPI DETERMINISTIC PRE-SHARE GATE (Wave 3 item 3.5).
 *
 * THE GAP THIS CLOSES: before this file, "do not share MNPI externally" existed ONLY as prose, a
 * tool description telling an LLM caller what not to do (graph_send_email's annotations, memory_write's
 * and memory_remember's "non-PHI, non-MNPI, non-privileged" docstrings, checkpoint's same line). An
 * LLM can be prompt-injected, can misjudge, or can simply be wrong. Nothing in the CODE stopped a
 * call whose content happened to carry finance-MNPI or attorney-privileged material from actually
 * reaching web_search, an outbound email, or the broadly-shared memory/commons feed. This module is
 * the code-level backstop: a deterministic string/regex scan run BEFORE the handler's side effect,
 * never an LLM judgment call.
 *
 * WHY THIS IS THE ONE HARD GATE IN THE FLEET (see otchealth-cto/CLAUDE.md): "no autonomous external
 * INND MNPI disclosure (SEC/Reg FD/HIPAA + personal officer liability)" is one of exactly two
 * unwaivable legal walls, not a self-imposed guardrail. Every OTHER safety module in this directory
 * (cold-start.ts, auto-guard.ts, jit-doctrine.ts, capture-pressure.ts) is fail-OPEN and mode-gated
 * (off/report/enforce) by design, because those are reversible, low-stakes nudges. This module is
 * deliberately the opposite on both counts:
 *   - FAIL CLOSED: any internal error while determining content provenance (a malformed input, a
 *     thrown exception, anything unexpected) is treated as a MATCH and the action is BLOCKED, never
 *     swallowed into "no match found, allow it". See the try/catch in each evaluate* function below.
 *   - NO MODE SWITCH: unlike SHIELD_MODE / GROUNDEDNESS_MODE / COLD_START_MODE, there is no env var
 *     that softens this to report-only. A hard-block call site always hard-blocks.
 *
 * WHAT IT DETECTS (deterministic, not LLM judgment): two independent, purely textual signals over
 * the free-text fields of a tool call --
 *   1. A literal mention of one of the six EXEC_RING-only room/index names (mirrors INDEX_LANES in
 *      tools/kb/search-privileged.ts) -- evidence the text was copied from, quotes, or otherwise
 *      references a privileged finance/legal room.
 *   2. An explicit MNPI/securities marker string. No producer in this codebase mints one today
 *      (grepped clean at the time this was written); the pattern is provided so a future producer
 *      has an unambiguous way to flag content, and so this gate has a second, independent signal
 *      beyond bare room-name mentions.
 * This is deliberately NARROW (room names + an explicit tag), not a broad secrets classifier: a
 * classifier that guesses at "does this look like MNPI" from arbitrary prose is exactly the kind of
 * judgment call this module exists to avoid making. Bare mentions of the company or its ticker are
 * NOT flagged (that would false-positive on nearly every ordinary internal message); only literal
 * room-name references or an explicit tag are.
 *
 * TWO ENFORCEMENT SHAPES, matching the two options in the Wave 3 item 3.5 brief:
 *   (a) HARD BLOCK, no caller exception -- for a destination that is by construction always
 *       non-privileged/broadly-shared/external, so there is no legitimate scenario in which
 *       EXEC_RING content should ever reach it via this tool. Used by evaluateBroadcastMnpiGate()
 *       (web_search's public query, memory_remember's commons feed, memory_write's and checkpoint's
 *       memory-exec index -- all readable by every connected agent regardless of ring).
 *   (b) EXEC_RING-REQUIRED fallback -- for a destination with a genuine internal/external split
 *       (email has a recipient list), where matched content going to an all-internal recipient set
 *       is not immediately a Reg FD violation but is still content no non-exec caller should be the
 *       one sending; matched content going to ANY external recipient is (a) regardless of caller.
 *       Used by evaluateEmailMnpiGate() (graph_send_email).
 *
 * Reuses isExecRingLane() from tools/kb/search-privileged.ts (the established ring-check pattern)
 * rather than re-deriving ring membership -- see that file's header for the ring definitions.
 */
import { isExecRingLane } from '../tools/kb/search-privileged.js';

/** The six EXEC_RING-only room/index identifiers, mirrored from INDEX_LANES in
 *  tools/kb/search-privileged.ts (imported as literal strings, not re-exported types, so this file
 *  has zero risk of drifting the RING DEFINITIONS themselves -- it only borrows the room names for
 *  a text-provenance heuristic). If search-privileged.ts ever adds or renames a privileged room,
 *  update this list in the same diff. */
export const EXEC_RING_ROOM_MARKERS = [
  'finance-cfo-source-docs',
  'finance-otchealth-cfo-source-docs',
  'finance-cfo-memory',
  'legal-company',
  'legal-personal-memory',
  'legal-personal',
] as const;

/** An explicit content tag. No producer in this codebase mints this today (grepped clean); reserved
 *  so a future explicit-marking convention has a deterministic string this gate already recognizes. */
export const MNPI_MARKER_REGEX = /\[mnpi\]|\bmnpi[-_ ]restricted\b|\bmnpi\b|material\s+non-?public\s+information/i;

/** Internal email domains. A recipient outside these is treated as external for the email gate. */
export const INTERNAL_EMAIL_DOMAINS = ['otchealth.app', 'otchealthmart.com', 'innd.com'] as const;

export interface MnpiScanMatch {
  matched: boolean;
  /** Which field matched (the object key passed into scanFieldsForMnpi), when matched is true. */
  field?: string;
  /** The literal marker text that matched (a room name or the MNPI regex match), when matched is true. */
  marker?: string;
}

/**
 * Scan ONE string for an EXEC_RING room-name mention or an explicit MNPI marker. Pure; does not
 * itself need a try/catch (string.includes/match on a real string cannot throw), but callers that
 * pass untrusted/possibly-non-string input should go through scanFieldsForMnpi below, which is the
 * one that carries the fail-closed try/catch.
 */
export function scanTextForMnpi(text: string): { matched: boolean; marker?: string } {
  const lower = text.toLowerCase();
  for (const marker of EXEC_RING_ROOM_MARKERS) {
    if (lower.includes(marker)) return { matched: true, marker };
  }
  const m = text.match(MNPI_MARKER_REGEX);
  if (m) return { matched: true, marker: m[0] };
  return { matched: false };
}

/**
 * Scan every string-valued field of `fields` for EXEC_RING room references or an explicit MNPI
 * marker. FAILS CLOSED: `fields` is walked with no defensive typeof/null guard up front -- if the
 * caller passes something that is not a plain object (null, a non-object, anything that makes
 * Object.entries throw), the exception propagates OUT of this function uncaught. Every call site
 * below (evaluateBroadcastMnpiGate / evaluateEmailMnpiGate) wraps its OWN try/catch around the full
 * decision, including this scan, and treats any thrown error as a match -- so an internal error
 * here still ends in a block, never a silent allow. This is the one place in the safety/ directory
 * that is deliberately built this way; every other module in this directory guards defensively and
 * fails open.
 */
export function scanFieldsForMnpi(fields: Record<string, string | undefined | null>): MnpiScanMatch {
  for (const [field, value] of Object.entries(fields)) {
    if (typeof value !== 'string' || !value) continue;
    const hit = scanTextForMnpi(value);
    if (hit.matched) return { matched: true, field, marker: hit.marker };
  }
  return { matched: false };
}

/** True when `address` is inside the internal domain allowlist. Pure. */
export function isInternalEmailAddress(address: string): boolean {
  const at = address.lastIndexOf('@');
  if (at < 0) return false;
  const domain = address.slice(at + 1).trim().toLowerCase();
  return (INTERNAL_EMAIL_DOMAINS as readonly string[]).some((d) => domain === d || domain.endsWith(`.${d}`));
}

/** True when ANY address in a comma-separated recipient list is outside the internal allowlist. An
 *  empty/blank list has no external recipient (vacuously false) -- callers only invoke this once
 *  they already know there is at least one non-empty recipient field to evaluate. */
export function hasExternalRecipient(addressesCsv: string): boolean {
  const addrs = addressesCsv.split(',').map((a) => a.trim()).filter(Boolean);
  return addrs.some((a) => !isInternalEmailAddress(a));
}

export interface MnpiGateOutcome {
  blocked: boolean;
  /** 'clear' = allowed; 'hard_block' = blocked, no caller can override; 'exec_ring_required' =
   *  blocked because the caller's lane is not EXEC_RING (an EXEC_RING caller would have passed). */
  tier: 'clear' | 'hard_block' | 'exec_ring_required';
  reason: string;
}

const CLEAR: MnpiGateOutcome = { blocked: false, tier: 'clear', reason: 'No EXEC_RING room reference or MNPI marker detected.' };

/**
 * The gate for tools whose destination is, BY CONSTRUCTION, always non-privileged/broadly-shared or
 * external, regardless of who calls it: web_search (the public web), memory_remember (the commons
 * feed every connected agent reads), memory_write and checkpoint (write-through indexed into
 * memory-exec, a room every agent's brain_search call reaches). There is no legitimate reason
 * EXEC_RING content should ever reach one of these via this tool, so a content match is an
 * unconditional HARD BLOCK -- no caller, not even an EXEC_RING lane, is exempt. FAILS CLOSED: any
 * thrown error while scanning is treated as a match.
 */
export function evaluateBroadcastMnpiGate(fields: Record<string, string | undefined | null>): MnpiGateOutcome {
  try {
    const scan = scanFieldsForMnpi(fields);
    if (!scan.matched) return CLEAR;
    return {
      blocked: true,
      tier: 'hard_block',
      reason:
        `HARD BLOCK: field "${scan.field}" references an EXEC_RING-gated room or carries an explicit ` +
        `MNPI/securities marker ("${scan.marker}"). This destination is always non-privileged and ` +
        `broadly shared or external; there is no legitimate reason EXEC_RING/MNPI content reaches it ` +
        `via this tool. Refused for every caller, including EXEC_RING lanes.`,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      blocked: true,
      tier: 'hard_block',
      reason: `MNPI gate failed CLOSED: internal error determining content provenance (${msg}). Refused rather than allowed.`,
    };
  }
}

/**
 * The gate for graph_send_email: a destination with a genuine internal/external recipient split.
 *   - content match + ANY external recipient  -> HARD BLOCK, no caller exception (option a: never
 *     legitimate to send EXEC_RING/MNPI content to an outside address through an unreviewed tool).
 *   - content match + every recipient internal -> requires the caller to be an EXEC_RING lane
 *     (option b, mirrors isExecRingLane); a non-exec caller is blocked, an EXEC_RING caller passes.
 *   - no content match -> clear regardless of recipients or caller (ordinary business email is
 *     unaffected; this gate only engages on a detected EXEC_RING/MNPI signal).
 * FAILS CLOSED: any thrown error (including a malformed recipients string) is treated as a match
 * against an external recipient, the strictest outcome.
 */
export function evaluateEmailMnpiGate(
  fields: Record<string, string | undefined | null>,
  recipientsCsv: string,
  callerLane: string | undefined | null,
): MnpiGateOutcome {
  try {
    const scan = scanFieldsForMnpi(fields);
    if (!scan.matched) return CLEAR;
    const external = hasExternalRecipient(recipientsCsv);
    if (external) {
      return {
        blocked: true,
        tier: 'hard_block',
        reason:
          `HARD BLOCK: field "${scan.field}" references an EXEC_RING-gated room or carries an explicit ` +
          `MNPI/securities marker ("${scan.marker}"), and at least one recipient is outside the internal ` +
          `domain allowlist (${INTERNAL_EMAIL_DOMAINS.join(', ')}). External MNPI/securities disclosure is ` +
          `an absolute legal wall (SEC Reg FD, personal officer liability) -- never sent, regardless of caller.`,
      };
    }
    if (!isExecRingLane(callerLane)) {
      return {
        blocked: true,
        tier: 'exec_ring_required',
        reason:
          `Refused: field "${scan.field}" references an EXEC_RING-gated room or carries an explicit ` +
          `MNPI/securities marker ("${scan.marker}"). All recipients are internal, but sending EXEC_RING/` +
          `MNPI content requires an EXEC_RING caller lane. Your identity: ${callerLane || '(none)'}.`,
      };
    }
    return {
      blocked: false,
      tier: 'clear',
      reason: `Content matched ("${scan.marker}") but every recipient is internal and the caller ("${callerLane}") is an EXEC_RING lane.`,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      blocked: true,
      tier: 'hard_block',
      reason: `MNPI gate failed CLOSED: internal error determining content/recipient provenance (${msg}). Refused rather than allowed.`,
    };
  }
}
