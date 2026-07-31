/**
 * PER-LANE TOOL-CATALOG CURATION (Wave 6 item 6.2) -- the real token-tax fix for internal
 * client_credentials lanes (cto, cfo, clo, clo-personal, coo, cro, cpo, cco, developer, exec). Every
 * tool advertised to a connected agent costs prompt tokens to describe in its tools/list response, so
 * a lane that only ever calls 10 of the ~850 registered tools is still paying the token cost of all
 * 850 being advertised on every connection.
 *
 * This module mirrors the existing safety/*.ts "mode" gates in this file's shape (cold-start.ts,
 * jit-doctrine.ts, capture-pressure.ts): a pure decision core (evaluateCatalogCuration, no IO, no env
 * read, fully unit-testable) plus a thin IO shell (recordLaneToolUsage) that owns the one side effect
 * (fire-and-forget telemetry). TOOL_CATALOG_CURATION_MODE is read FRESH from process.env per call
 * (NOT added to the Zod schema in config/env.ts), same reasoning as SHIELD_MODE / COLD_START_MODE /
 * JIT_DOCTRINE_MODE documented there: it can be flipped by an env change with no code redeploy.
 *
 *   TOOL_CATALOG_CURATION_MODE  off | report (DEFAULT) | curate | curate-m365-only
 *
 * STANDING FLEET DIRECTIVE (otchealth-claude-tools/CLAUDE.md, "GUARDRAILS DOWN"): no self-imposed
 * gate defaults to blocking; report-mode-first, no dry-run-first. This feature honors that directly --
 * the DEFAULT is 'report', which NEVER restricts what any lane sees. It only observes and annotates
 * real usage so a future, evidence-backed decision to curate is possible. 'curate'/'curate-m365-only'
 * are explicit, non-default opt-ins a human flips only after reviewing real gw_lane_tool_used data
 * (or, for curate-m365-only, on the specific evidence documented below).
 *
 *  - 'off'    -> full no-op. No advertised-tool filtering, no usage telemetry at all. The escape
 *                hatch if the report-mode logging itself needs to be silenced (e.g. a telemetry-cost
 *                concern), independent of ever wanting to curate.
 *  - 'report' -> (DEFAULT) every internal lane keeps seeing the FULL, uncurated tool catalog exactly
 *                as before this feature shipped (advertise is ALWAYS true). The only effect is a
 *                fire-and-forget telemetry emit, per actual tool call, annotated with whether that
 *                tool is in the lane's SEED allowlist (config/lane-toolsets.ts) -- building toward
 *                real usage data before anyone commits to a curated list.
 *  - 'curate' -> actually narrows the advertised tools/list response to each known internal lane's
 *                seed allowlist (registry.ts's registerTool early-returns before registering a tool
 *                not on the list, mirroring the pre-existing connector-surface curation), for EVERY
 *                caller on a known internal lane -- including a Claude Code agent session using the
 *                same client_credentials lane. Usage telemetry keeps firing in this mode too, so the
 *                picture keeps refining.
 *  - 'curate-m365-only' -> the SAME narrowing as 'curate', but ONLY applied when the request
 *                authenticated via an M365 declarative-agent static token (request-context.ts's
 *                isM365StaticAuth()). A Claude Code / other client_credentials session on the exact
 *                same lane (e.g. 'cto') is left fully uncurated, exactly like 'report' mode, even
 *                while curate-m365-only is active. WHY THIS MODE EXISTS (2026-07-31 finding, see
 *                ledger cto__20260729-002): every M365 lane's raw tools/list was observed returning
 *                the FULL ~1665-tool catalog, identical across all six lanes regardless of what each
 *                agent's Copilot manifest declares (8-122 tools) -- a large, unscoped tools/list
 *                during Copilot's MCP initialize handshake matches two ALREADY-CONFIRMED precedents
 *                in this codebase where M365/Copilot silently truncates or rejects an oversized tool
 *                catalog (GitHub Copilot's hard 128-tool cap for otchealth-dev; the wake() payload-size
 *                fix). 'curate' (unscoped) was judged too risky to flip blind -- it would ALSO curate
 *                every exec agent's live Claude Code session on the same lane down to a first-pass,
 *                unproven seed allowlist, a real regression risk this mode avoids entirely by
 *                construction: it can only ever affect M365 static-token requests.
 *
 * FAIL-OPEN BY CONSTRUCTION, mirroring every other mode-gate in this directory:
 *  - An unrecognized lane (not in KNOWN_INTERNAL_LANES) is NEVER curated and NEVER logged, in any
 *    mode -- this feature only narrows lanes it has an explicit, documented opinion about; it can
 *    never silently empty an unscoped caller's toolset.
 *  - A Claude Chat (DCR/occ_) connector request is COMPLETELY OUT OF SCOPE for this module -- that
 *    surface already has its own, separate curation (registry.ts's connectorToolset() /
 *    CONNECTOR_TOOLSET / EXTERNAL_READONLY_TOOLSET), untouched by this feature. registry.ts only
 *    consults this module on the NON-connector-surface (client_credentials) request path.
 *  - recordLaneToolUsage never throws (telemetry must never affect the tool call it rides on) and is
 *    a genuine no-op whenever POSTHOG_GATEWAYOPS_KEY is unset (see telemetry/gateway-ops.ts).
 */
import { captureGatewayEvent } from '../telemetry/gateway-ops.js';
import { isKnownInternalLane, isToolInLaneAllowlist } from '../config/lane-toolsets.js';

export type ToolCatalogCurationMode = 'off' | 'report' | 'curate' | 'curate-m365-only';

/** Parse TOOL_CATALOG_CURATION_MODE, defaulting to 'report' (fail-open / non-restricting on garbage
 * or unset input, per the standing "report-mode-first" directive). Pure. */
export function parseToolCatalogCurationMode(value: string | undefined): ToolCatalogCurationMode {
  const v = (value || '').trim().toLowerCase();
  return v === 'off' || v === 'curate' || v === 'curate-m365-only' ? v : 'report';
}

export interface CatalogCurationDecision {
  mode: ToolCatalogCurationMode;
  /** Whether `toolName` should be ADVERTISED (kept in the tools/list response) for this lane. Always
   * true in 'off' and 'report' modes, and always true for an unscoped lane in every mode -- only
   * 'curate' + a KNOWN internal lane + a tool outside that lane's seed allowlist ever sets this false. */
  advertise: boolean;
  /** Whether `toolName` is in `lane`'s seed allowlist (config/lane-toolsets.ts). Null when the
   * question does not apply: mode='off', or `lane` is not a known internal lane. */
  inSeedAllowlist: boolean | null;
}

/**
 * Pure decision core for the REGISTRATION-time question: should `toolName` be advertised to this
 * internal client_credentials `lane`? No IO, no env read (mode is passed in already-parsed) --
 * fully deterministic and unit-testable. Called ONLY on the non-connector-surface request path; see
 * this file's header and registry.ts's call site.
 *
 * `isM365` (default false) is request-context.ts's isM365StaticAuth() at the call site -- it ONLY
 * matters for mode='curate-m365-only', where it is the entire gate: true narrows exactly like
 * 'curate', false always advertises (see this file's header for why this split exists).
 */
export function evaluateCatalogCuration(
  mode: ToolCatalogCurationMode,
  lane: string,
  toolName: string,
  isM365 = false,
): CatalogCurationDecision {
  if (mode === 'off') return { mode, advertise: true, inSeedAllowlist: null };
  if (!isKnownInternalLane(lane)) return { mode, advertise: true, inSeedAllowlist: null };
  const inSeedAllowlist = isToolInLaneAllowlist(lane, toolName);
  const shouldCurate = mode === 'curate' || (mode === 'curate-m365-only' && isM365);
  const advertise = shouldCurate ? inSeedAllowlist : true;
  return { mode, advertise, inSeedAllowlist };
}

/**
 * IO shell: fire-and-forget usage telemetry -- "lane X actually called tool Y", annotated with
 * whether Y is in X's seed allowlist right now. Reuses the existing gateway-ops capture pattern
 * (telemetry/gateway-ops.ts's captureGatewayEvent): inert unless POSTHOG_GATEWAYOPS_KEY is set, never
 * awaited by the caller, never throws. Fires in BOTH 'report' and 'curate' modes (curate keeps
 * benefiting from the same ongoing usage signal); only 'off' is silent. This is the mechanism that
 * builds the real usage data the module header describes -- query the gw_lane_tool_used stream to
 * refine config/lane-toolsets.ts's seed allowlists before ever flipping a lane to 'curate'.
 */
export function recordLaneToolUsage(
  decision: CatalogCurationDecision,
  lane: string,
  toolName: string,
  callerHash?: string,
): void {
  if (decision.mode === 'off') return;
  try {
    captureGatewayEvent(
      'gw_lane_tool_used',
      { lane, tool: toolName, in_seed_allowlist: decision.inSeedAllowlist, mode: decision.mode },
      callerHash,
    );
  } catch {
    // Fail-open: telemetry must never affect the tool call it rides on.
  }
}
