/**
 * Hyperagent broker — ring enforcement.
 *
 * WHY THIS FILE EXISTS. Hyperagent's own MCP server has NO per-agent authorization. Its scopes are
 * `threads:read threads:write approvals:read approvals:write` with no agent dimension, and its docs
 * state plainly: "A connected client gets no access you don't already have. It can only reach the
 * agents you can." So a single consent grants read/write across EVERY thread on the account,
 * including the CLO's (attorney-privileged, a live California family matter involving minors) and
 * the CFO's (MNPI).
 *
 * That is the exact inverse of this gateway, which ring-gates per lane. Connecting each Claude agent
 * directly to Hyperagent would therefore produce N credentials with IDENTICAL account-wide authority
 * — N keys to the same building — while LOOKING like per-agent isolation. This module exists so the
 * isolation is real: the gateway holds one Hyperagent credential and decides, per caller lane, which
 * Hyperagent agent may be addressed at all.
 *
 * THE POSTURE IS DENY-BY-DEFAULT, and that is deliberate rather than cautious-by-habit. The real
 * Hyperagent agent ids live on Matt's account and are not known at build time, so the mapping is
 * supplied at runtime (HYPERAGENT_LANE_AGENTS). An agent that is not explicitly mapped is treated as
 * PRIVILEGED and refused. The failure mode of guessing wrong in the other direction is brokering a
 * privileged thread to a lane that must never see it, which is precisely the cross-ring leak closed
 * on 2026-07-16 — so unknown must mean no.
 */

/** Lanes permitted to reach an agent classified as personal-legal. Mirrors PERSONAL_LEGAL_RING. */
export const HYPERAGENT_PERSONAL_LEGAL_RING: readonly string[] = ['clo-personal', 'exec'];

/** Lanes permitted to reach an agent classified as executive/privileged (finance, company legal). */
export const HYPERAGENT_EXEC_RING: readonly string[] = ['cfo', 'clo', 'clo-personal', 'cpo', 'cco', 'exec'];

/**
 * Classification of a Hyperagent agent, from most to least restricted. `unknown` is not a gap in the
 * taxonomy — it is the safe landing spot for anything the operator has not explicitly classified,
 * and it denies every lane.
 */
export type HyperagentClass = 'personal-legal' | 'exec' | 'general' | 'unknown';

/**
 * Name fragments that force a classification regardless of the configured map. This is a BACKSTOP,
 * not the primary mechanism: if someone maps `clo-personal-agent` into the `general` bucket by
 * mistake, this still refuses it. Matched case-insensitively against the agent's name AND id.
 *
 * Deliberately narrow. A broad pattern list would misclassify ordinary agents as privileged and
 * quietly break the integration, which trains people to widen the map until the backstop is
 * meaningless. Each entry here names a real privileged surface in this fleet.
 */
const FORCED_PERSONAL_LEGAL = ['clo-personal', 'clo_personal', 'personal-legal', 'personal_legal'];
// `wefunder`, `investor` and `reg-cf` were added on 2026-08-18 after reading the REAL agent list for
// the first time. The account holds "Wefunder Campaign Director" and "Wefunder Investor Focus
// Group", and neither matched any pattern above — both would have been reachable by every lane.
// That is Reg CF securities material, where the fleet's standing rule is attorney-and-owner gated,
// so a broadly-readable default was exactly wrong. The general lesson is worth keeping: this
// backstop could only be calibrated against the actual names, never guessed from the design.
const FORCED_EXEC = ['cfo', 'clo', 'capital', 'finance', 'mnpi', 'legal', 'wefunder', 'investor', 'reg-cf', 'reg cf'];

/**
 * Parse the runtime lane→agent map.
 *
 * Format (env `HYPERAGENT_LANE_AGENTS`), semicolon-separated, each entry `lane=agentId[,agentId...]`:
 *   cto=ag_123,ag_456;cfo=ag_789;developer=ag_abc
 *
 * A lane absent from the map reaches nothing. An agent absent from every lane's list is `unknown`
 * and reachable by nobody. Both are intentional: the map is an allowlist, and an allowlist that
 * silently admits unlisted entries is not an allowlist.
 */
export function parseLaneAgentMap(raw: string | undefined | null): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (!raw) return out;
  for (const entry of raw.split(';')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue; // malformed entry is DROPPED, never interpreted as a wildcard
    const lane = trimmed.slice(0, eq).trim().toLowerCase();
    const agents = trimmed
      .slice(eq + 1)
      .split(',')
      .map((a) => a.trim())
      .filter(Boolean);
    if (!lane || agents.length === 0) continue;
    out[lane] = (out[lane] ?? []).concat(agents);
  }
  return out;
}

/**
 * Parse the explicit classification map (env `HYPERAGENT_AGENT_CLASSES`), format
 * `agentId=class[;agentId=class...]` where class is personal-legal | exec | general.
 * Anything unparseable or unlisted stays `unknown`.
 */
export function parseAgentClassMap(raw: string | undefined | null): Record<string, HyperagentClass> {
  const out: Record<string, HyperagentClass> = {};
  if (!raw) return out;
  for (const entry of raw.split(';')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const id = trimmed.slice(0, eq).trim();
    const cls = trimmed.slice(eq + 1).trim().toLowerCase();
    if (!id) continue;
    if (cls === 'personal-legal' || cls === 'exec' || cls === 'general') out[id] = cls;
    // An unrecognised class string is DROPPED so the agent stays `unknown` (denied), rather than
    // being coerced to `general` (permitted) — a typo must never widen access.
  }
  return out;
}

/**
 * Classify an agent. Forced patterns win over the configured map, so a misconfiguration cannot
 * downgrade a privileged agent.
 */
export function classifyAgent(
  agent: { id?: string | null; name?: string | null },
  classMap: Record<string, HyperagentClass>,
): HyperagentClass {
  const id = (agent.id ?? '').trim();
  const hay = `${agent.id ?? ''} ${agent.name ?? ''}`.toLowerCase();

  if (FORCED_PERSONAL_LEGAL.some((p) => hay.includes(p))) return 'personal-legal';
  // NOTE ordering: personal-legal is checked FIRST because "clo-personal" also contains "clo",
  // which is in FORCED_EXEC. Reversing these two blocks would silently downgrade the most
  // sensitive surface in the fleet to the merely-executive ring.
  if (FORCED_EXEC.some((p) => hay.includes(p))) return 'exec';

  const explicit = id ? classMap[id] : undefined;
  if (explicit) return explicit;
  return 'unknown';
}

/** Lanes allowed to reach a given classification. `unknown` and anything else reach nobody. */
export function ringForClass(cls: HyperagentClass): readonly string[] | 'all' | 'none' {
  if (cls === 'personal-legal') return HYPERAGENT_PERSONAL_LEGAL_RING;
  if (cls === 'exec') return HYPERAGENT_EXEC_RING;
  if (cls === 'general') return 'all';
  return 'none';
}

/**
 * THE ENFORCEMENT PREDICATE. Pure, so it is unit-testable without a network or a token.
 *
 * Two independent conditions must BOTH hold:
 *   1. the caller's lane must be explicitly mapped to this agent id (the allowlist), and
 *   2. the caller's lane must be inside the agent's classification ring (the ring).
 *
 * Requiring both is the point. The allowlist alone would let an operator hand `cto` a CFO agent by
 * editing one env var; the ring alone would let any exec-ring lane reach every exec agent whether or
 * not it was ever assigned one. Together, widening access takes a deliberate change in two places.
 */
export function isHyperagentAgentAllowed(
  caller: string | undefined | null,
  agent: { id?: string | null; name?: string | null },
  laneMap: Record<string, string[]>,
  classMap: Record<string, HyperagentClass>,
): { allowed: boolean; reason: string; cls: HyperagentClass } {
  const lane = (caller ?? '').trim().toLowerCase();
  const id = (agent.id ?? '').trim();
  const cls = classifyAgent(agent, classMap);

  if (!lane) return { allowed: false, reason: 'no_caller_identity', cls };
  if (!id) return { allowed: false, reason: 'agent_id_unknown', cls };

  const ring = ringForClass(cls);
  if (ring === 'none') return { allowed: false, reason: 'agent_unclassified', cls };
  if (ring !== 'all' && !ring.includes(lane)) return { allowed: false, reason: 'forbidden_ring', cls };

  const assigned = laneMap[lane] ?? [];
  if (!assigned.includes(id)) return { allowed: false, reason: 'agent_not_assigned_to_lane', cls };

  return { allowed: true, reason: 'ok', cls };
}

/**
 * Filter a list of agents down to what a lane may see. Used by `hyperagent_list_agents` so a lane
 * never even learns that a privileged agent exists — an authorization failure that still leaks the
 * NAME of a privileged matter is a smaller leak, not a non-leak.
 */
export function visibleAgentsFor<T extends { id?: string | null; name?: string | null }>(
  caller: string | undefined | null,
  agents: readonly T[],
  laneMap: Record<string, string[]>,
  classMap: Record<string, HyperagentClass>,
): T[] {
  return agents.filter((a) => isHyperagentAgentAllowed(caller, a, laneMap, classMap).allowed);
}
