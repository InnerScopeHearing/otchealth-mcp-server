/**
 * Work-ledger attribution binding (FND-20260829-878f).
 *
 * SOURCE: otchealth-mcp-server PR #263 review (sentry-bot prediction triage, 2026-08-29). The raw
 * bot prediction claimed task_create/task_update/agent_dispatch lacked in-handler ring checks for
 * the newly-curated coo/cro connector lanes; triage found the narrower, real defect underneath --
 * every task_* work-ledger tool (task_create, task_claim, task_update, task_heartbeat,
 * task_complete) took its actor/agent/created_by field STRAIGHT FROM CALLER INPUT and wrote it to
 * Cosmos/Postgres verbatim, with no check against the caller's own authenticated identity. A
 * coo-lane connector token could call task_create({created_by:"cto", ...}) and the ledger would
 * record "cto" as the creator -- indistinguishable, on paper, from a genuine cto-lane call.
 *
 * WHY THIS IS AN ATTRIBUTION ISSUE, NOT A NEW ACCESS-CONTROL WALL (severity:low in the ledger):
 * the work ledger is a deliberately cross-engine, cross-lane DISPATCH surface -- one agent
 * legitimately creates a task and assigns it to a DIFFERENT named owner_agent, or reassigns one via
 * task_update, or writes created_by:"matt" as a human-readable shorthand for "a person asked for
 * this through my session." None of that is wrong, and this fix does not touch it (owner_agent
 * reassignment on task_create/task_update is untouched -- see each tool's own comment). What is
 * wrong is trusting the caller's OWN claimed identity as the ledger's record of who actually placed
 * the call. resolveAttribution below is the single point that fixes that: the caller's verified
 * token-bound lane (ctx.callerAgent, itself sourced from auth/bearer.ts's AuthContext.caller_agent
 * -- "the agent identity derived from the caller's OAuth token", never client-suppliable) is always
 * the RECORDED actor; a caller-supplied value that disagrees is preserved as `claimed_actor` for
 * audit, never substituted in as the truth.
 *
 * CONTRAST WITH memory_write's memoryWriteIdentityRefusal (src/tools/agentstate/memory-write.ts):
 * that tool is documented, and has always been documented, as SELF-WRITE-ONLY into a single
 * broadly-shared, brain_search-recallable memory-of-record, so a mismatch there is a hard, fail-
 * closed REFUSAL before anything is touched. The work ledger has no such self-write-only contract
 * (task_create/task_update legitimately name other agents via owner_agent), so a mismatch on the
 * ACTOR field specifically is not inherently malicious or even unusual -- it just must never be
 * recorded as ground truth. Silently overriding with an honest, audited correction is the
 * proportionate fix here; see FND-20260829-878f for the full triage.
 *
 * `tokenAgent` empty is a defensive fallback, not the expected path: every task_* tool is
 * write_simple (mutating) and already requires bearer auth (src/tools/registry.ts's dispatch path)
 * before any handler runs, so ctx.callerAgent is normally always populated. If it is somehow empty
 * (e.g. a future auth path that resolves no agent claim at all), fall back to the caller-supplied
 * value verbatim rather than recording an empty/unattributable actor -- there is nothing more
 * truthful to bind to in that case, and refusing outright would be a bigger behavior change than
 * this low-severity finding calls for.
 */

export interface ResolvedAttribution {
  /** The value to actually persist as the ledger's actor/agent/created_by field. Always the
   *  token-bound identity when one is available. */
  actor: string;
  /** Present ONLY when the caller supplied a non-empty identity that differs (case-insensitively)
   *  from the token-bound one. Never treated as authoritative; carried for audit alongside `actor`. */
  claimed_actor?: string;
}

/**
 * Bind a work-ledger actor/agent/created_by field to the caller's authenticated token identity.
 *
 * @param tokenAgent   ctx.callerAgent (or currentCallerAgent()) -- the verified, non-forgeable
 *                      identity resolved from the caller's bearer credential.
 * @param claimedActor The caller-supplied value from tool input (e.g. input.created_by, input.agent,
 *                      input.actor). May legitimately equal tokenAgent (the overwhelmingly common
 *                      case for an honest caller), differ from it, or be empty.
 */
export function resolveAttribution(tokenAgent: string, claimedActor: string): ResolvedAttribution {
  const token = (tokenAgent || '').trim();
  const claimed = (claimedActor || '').trim();
  if (!token) return { actor: claimed };
  if (!claimed || claimed.toLowerCase() === token.toLowerCase()) return { actor: token };
  return { actor: token, claimed_actor: claimed };
}
