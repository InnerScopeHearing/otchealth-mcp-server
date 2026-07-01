/**
 * Charter enforcement (Phase 5): the tool-call path checks a caller's agent charter
 * BEFORE the handler runs, in report-mode by default so shipping this changes zero
 * live behavior until a deliberate ops flip.
 *
 * The charter FRAMEWORK (the agent-charter JSON schema + the real per-agent charter
 * files: charter-cto.json / charter-cfo.json / charter-clo.json, etc.) lives in the
 * otchealth-claude-tools repo under dream-team/governance/. This module mirrors that
 * shape as a small, in-gateway charter map keyed by agent lane, so the gateway can
 * evaluate a call without a cross-repo fetch. When the claude-tools charters become
 * the generated source of truth, swap CHARTERS below for a generated import; keep the
 * evaluate() contract stable so callers (registry.ts, tests) do not need to change.
 *
 * GOVERNANCE_MODE (read fresh from process.env on every call, so an ops flip via the
 * app-settings env takes effect without a redeploy):
 *   - 'off' (default, and the value for anything unset/unrecognized): a pure no-op.
 *     evaluate() is never called from the hot path in a way that can block; the
 *     handler always runs and nothing is logged. THIS MUST STAY THE DEFAULT so that
 *     merging and deploying this module changes no observable behavior.
 *   - 'report': a would-deny is logged as a single-line structured JSON via
 *     console.warn (so it is visible in the platform's log stream without any new
 *     logging dependency), but the tool STILL RUNS. Never blocks.
 *   - 'enforce': a deny returns the registry's standard error tool-result shape and
 *     the wrapped handler is NEVER invoked.
 *
 * Existing role-gate note: src/catalog/governance.ts already gates a curated list of
 * individual HIGH-RISK tool names to specific roles (e.g. depot_*, github_push_files
 * are cto-only) and is enforced unconditionally in registry.ts. This module is a
 * SEPARATE, coarser layer: a per-agent-lane allow-list over tool CATEGORY (read /
 * write_simple / write_orchestrated), gated end-to-end behind GOVERNANCE_MODE so it
 * can be rolled out gradually. The two layers are independent and additive; neither
 * replaces the other.
 */

import type { ToolCategory } from '../tools/registry.js';
import { captureGatewayEvent } from '../telemetry/gateway-ops.js';

export type GovernanceMode = 'off' | 'report' | 'enforce';

export type CharterAuthority = 'propose' | 'commit';

export interface AgentCharter {
  /** Tool categories this lane may execute. */
  allowedCategories: ToolCategory[];
  /** Individual tool names denied even if their category is allowed (exact match). */
  deniedTools?: string[];
  /** propose = the lane's writes are expected to route through a human/CTO approval
   *  step outside the gateway; commit = the lane may act directly. Informational for
   *  now (surfaced in the deny reason); not yet used to gate a distinct behavior. */
  authority: CharterAuthority;
}

export type GovernanceDecision =
  | { decision: 'allow'; reason: string }
  | { decision: 'deny'; reason: string };

/**
 * Seed charter map, mirroring the shape of the claude-tools dream-team/governance/
 * charter-<agent>.json files. Extend here (or generate this object from those files)
 * as more lanes get a real charter. Unknown lanes fall through to DEFAULT_CHARTER
 * (permissive: read + write_simple, propose authority) so a not-yet-chartered agent
 * is not silently blocked in report mode, and is only mildly restricted in enforce
 * mode (it can still read and do simple writes; only orchestrated/high-risk writes
 * are denied by default).
 */
export const CHARTERS: Record<string, AgentCharter> = {
  cto: {
    allowedCategories: ['read', 'write_simple', 'write_orchestrated'],
    authority: 'commit',
  },
  cfo: {
    allowedCategories: ['read', 'write_simple'],
    authority: 'propose',
  },
  clo: {
    allowedCategories: ['read', 'write_simple'],
    authority: 'propose',
  },
  commerce: {
    allowedCategories: ['read', 'write_simple'],
    authority: 'propose',
  },
  developer: {
    allowedCategories: ['read', 'write_simple'],
    authority: 'propose',
  },
};

/** Applied to any caller lane not present in CHARTERS. */
export const DEFAULT_CHARTER: AgentCharter = {
  allowedCategories: ['read', 'write_simple'],
  authority: 'propose',
};

function charterFor(agentLane: string): AgentCharter {
  return CHARTERS[agentLane] ?? DEFAULT_CHARTER;
}

/**
 * Pure decision function: does agentLane's charter permit calling toolName in
 * category? No IO, no env reads, no logging, safe to unit test directly and safe
 * to call from any mode (the mode only decides what to DO with the decision).
 */
export function evaluate(
  agentLane: string,
  toolName: string,
  category: ToolCategory,
): GovernanceDecision {
  const charter = charterFor(agentLane);
  const lane = agentLane || '(no agent identity)';

  if (charter.deniedTools?.includes(toolName)) {
    return {
      decision: 'deny',
      reason: `Charter for "${lane}" explicitly denies "${toolName}" (authority: ${charter.authority}).`,
    };
  }
  if (!charter.allowedCategories.includes(category)) {
    return {
      decision: 'deny',
      reason:
        `Charter for "${lane}" does not permit category "${category}" ` +
        `(allowed: ${charter.allowedCategories.join(', ')}; authority: ${charter.authority}).`,
    };
  }
  return { decision: 'allow', reason: `Charter for "${lane}" permits category "${category}".` };
}

/** Read GOVERNANCE_MODE from process.env fresh on every call (no caching), defaulting
 *  to 'off' for anything unset or not one of the three recognized values. */
export function currentGovernanceMode(): GovernanceMode {
  const raw = process.env.GOVERNANCE_MODE;
  if (raw === 'report' || raw === 'enforce') return raw;
  return 'off';
}

export interface GovernanceCheckResult {
  /** true = the caller should proceed straight to the handler (allow, or mode=off/report). */
  proceed: boolean;
  /** Present only when proceed=false (mode=enforce and the charter denied the call). */
  denial?: { reason: string; agentLane: string; tool: string; category: ToolCategory };
}

/**
 * The single entry point registry.ts calls. Encapsulates the mode branching so the
 * hot path in registry.ts stays a one-line call. Never throws.
 *
 *  - off:     returns {proceed:true} immediately; evaluate() is not even invoked.
 *  - report:  invokes evaluate(); on deny, emits one console.warn JSON line and
 *             still returns {proceed:true} (never blocks).
 *  - enforce: invokes evaluate(); on deny, returns {proceed:false, denial} so the
 *             caller can short-circuit before running the handler.
 */
export function checkGovernance(
  agentLane: string,
  toolName: string,
  category: ToolCategory,
): GovernanceCheckResult {
  const mode = currentGovernanceMode();
  if (mode === 'off') return { proceed: true };

  const result = evaluate(agentLane, toolName, category);
  if (result.decision === 'allow') return { proceed: true };

  // result.decision === 'deny' from here on.
  if (mode === 'report') {
    console.warn(
      JSON.stringify({
        governance: 'would-deny',
        agent: agentLane || null,
        tool: toolName,
        category,
        reason: result.reason,
      }),
    );
    // Observe-only: mirror the would-deny to the Gateway Ops PostHog project so report-mode
    // has a readable sink (the prerequisite for graduating GOVERNANCE_MODE). Fire-and-forget;
    // inert unless POSTHOG_GATEWAYOPS_KEY is set; never affects proceed.
    captureGatewayEvent(
      'gateway_governance_would_deny',
      { agent: agentLane || null, tool: toolName, category, reason: result.reason },
      agentLane || undefined,
    );
    return { proceed: true };
  }

  // mode === 'enforce'
  return {
    proceed: false,
    denial: { reason: result.reason, agentLane, tool: toolName, category },
  };
}
