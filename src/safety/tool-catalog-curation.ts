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
 *                isM365StaticAuth()), OR the caller's lane is explicitly opted in via
 *                TOOL_CATALOG_CURATE_LANES (see below). A Claude Code / other client_credentials
 *                session on the exact same lane (e.g. 'cto') is left fully uncurated, exactly like
 *                'report' mode, even while curate-m365-only is active, UNLESS that lane is named in
 *                the opt-in list. WHY THIS MODE EXISTS (2026-07-31 finding, see ledger
 *                cto__20260729-002): every M365 lane's raw tools/list was observed returning the FULL
 *                ~1665-tool catalog, identical across all six lanes regardless of what each agent's
 *                Copilot manifest declares (8-122 tools) -- a large, unscoped tools/list during
 *                Copilot's MCP initialize handshake matches two ALREADY-CONFIRMED precedents in this
 *                codebase where M365/Copilot silently truncates or rejects an oversized tool catalog
 *                (GitHub Copilot's hard 128-tool cap for otchealth-dev; the wake() payload-size fix).
 *                'curate' (unscoped) was judged too risky to flip blind -- it would ALSO curate every
 *                exec agent's live Claude Code session on the same lane down to a first-pass, unproven
 *                seed allowlist, a real regression risk this mode avoids entirely by construction: it
 *                can only ever affect M365 static-token requests, PLUS whichever individual lanes an
 *                operator has explicitly and separately opted in (below).
 *
 * TOOL_CATALOG_CURATE_LANES (2026-08-18, "cro advertises tools it can never use" finding): a
 * comma-separated list of KNOWN_INTERNAL_LANE names (e.g. "cro" or "cro,cpo") that should be curated
 * under curate-m365-only EVEN for a non-M365 (plain client_credentials) caller. Defaults to EMPTY --
 * every existing lane's behavior is byte-for-byte unchanged until an operator names it here. This
 * exists because "coo's tools/list is narrow (11 tools) while cro's is wide (1008 tools)" is NOT a
 * per-lane inconsistency in evaluateCatalogCuration() itself -- it is two DIFFERENT gateway
 * mechanisms being compared: coo's 11 tools come from the UNRELATED, unconditional connector-surface
 * curation (tools/registry.ts's EXTERNAL_READONLY_TOOLSET, reached only via a dcr_/occ_ client id,
 * never gated by TOOL_CATALOG_CURATION_MODE at all -- connectorToolset(env, 'coo') is exactly 11,
 * live-verified against this repo's own registered catalog); cro's 1008 tools is a plain
 * client_credentials (non-connector, non-M365) session hitting THIS module, where curate-m365-only is
 * -- by design, per the paragraph above -- scoped to M365 callers only, on EVERY internal lane, not
 * just cro. So cro is not special-cased incorrectly; it is behaving exactly like cto/cfo/clo/etc.
 * would under the same non-M365 client_credentials conditions. Actually curating cro's non-M365
 * traffic requires EITHER flipping the mode to plain 'curate' (global blast radius -- narrows cto too,
 * an operator call, not this fix's to make) OR opting cro in here specifically, once its seed
 * allowlist (config/lane-toolsets.ts's LANE_TOOLSETS.cro / CRO_M365_CURATED) has been reviewed against
 * real gw_lane_tool_used data for that lane -- the exact same "prove it before curating" discipline
 * 'curate'/'curate-m365-only' themselves were built around. This flag does not decide that for you;
 * it only makes the decision expressible per-lane without touching any other lane's behavior.
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

/**
 * Parse TOOL_CATALOG_CURATE_LANES (see this file's header) into the set of lanes that should be
 * curated under curate-m365-only even for a non-M365 caller. Pure, fail-open on garbage: unset/empty
 * input, a bare comma, or a name not in KNOWN_INTERNAL_LANES all contribute nothing rather than
 * throwing or matching unpredictably -- this knob can only ever ADD curation to a lane an operator
 * explicitly named, never remove it and never affect an unrecognized lane (isKnownInternalLane is the
 * same gate evaluateCatalogCuration itself applies, so a typo here is silently inert rather than a
 * surprise no-op discovered later).
 */
export function parseCurateLaneOverrides(value: string | undefined): ReadonlySet<string> {
  const out = new Set<string>();
  for (const raw of (value || '').split(',')) {
    const lane = raw.trim().toLowerCase();
    if (lane && isKnownInternalLane(lane)) out.add(lane);
  }
  return out;
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
 * internal client_credentials `lane`? No IO, no env read (mode + the lane-override set are passed in
 * already-parsed) -- fully deterministic and unit-testable. Called ONLY on the non-connector-surface
 * request path; see this file's header and registry.ts's call site.
 *
 * `isM365` (default false) is request-context.ts's isM365StaticAuth() at the call site -- under
 * mode='curate-m365-only' it is ONE of two ways a lane gets curated (true narrows exactly like
 * 'curate'; see this file's header for why this split exists). `laneOverrides` (default an empty set
 * -- every existing call site that omits it behaves EXACTLY as before this parameter was added) is
 * the OTHER way: TOOL_CATALOG_CURATE_LANES's parsed set (parseCurateLaneOverrides), letting an
 * operator opt one specific known lane into curate-m365-only's narrowing even for a non-M365 caller,
 * without widening curation to every other lane the way flipping the mode itself to plain 'curate'
 * would. Has zero effect under 'off'/'report' (never curate) or plain 'curate' (already curates
 * unconditionally) -- it only ever matters for mode='curate-m365-only'.
 */
export function evaluateCatalogCuration(
  mode: ToolCatalogCurationMode,
  lane: string,
  toolName: string,
  isM365 = false,
  laneOverrides: ReadonlySet<string> = new Set(),
): CatalogCurationDecision {
  if (mode === 'off') return { mode, advertise: true, inSeedAllowlist: null };
  if (!isKnownInternalLane(lane)) return { mode, advertise: true, inSeedAllowlist: null };
  const inSeedAllowlist = isToolInLaneAllowlist(lane, toolName);
  const shouldCurate = mode === 'curate' || (mode === 'curate-m365-only' && (isM365 || laneOverrides.has(lane)));
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
