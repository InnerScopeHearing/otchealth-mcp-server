/**
 * Governance policy: which tools require a specific agent ROLE to EXECUTE.
 *
 * Every agent can SEE every tool (full discovery), but some actions are role-gated. The classic
 * rule: build/release actions are CTO-only even though all agents can see the tool. Rules are
 * declared here centrally (no per-tool edits) and enforced in tools/registry.ts using the caller's
 * OAuth-derived agent identity. Documented in the Capability Catalog so agents self-understand.
 *
 * Matching: exact tool name OR a prefix pattern ending in '*'.
 */
export interface GovRule {
  pattern: string;        // exact name or 'prefix*'
  requiredRole: string;   // agent id that may execute, e.g. 'cto'
  reason: string;
}

export const GOVERNANCE: GovRule[] = [
  // Builds / releases are CTO-only (visible to all, executable by CTO only).
  { pattern: 'depot_*', requiredRole: 'cto', reason: 'iOS/CI builds + TestFlight uploads are CTO-only (single initiator for consistency).' },
  { pattern: 'build_*', requiredRole: 'cto', reason: 'Build/release dispatch is CTO-only.' },
  { pattern: 'release_*', requiredRole: 'cto', reason: 'Release cutovers are CTO-only.' },
  // DNS / infra writes are CTO-only (charter: DNS + infra changes are CTO-owned).
  { pattern: 'cloudflare_create_dns_record', requiredRole: 'cto', reason: 'DNS changes are CTO-owned infrastructure.' },
  // GitHub writes are CTO-only (code pushes / PRs / merges are a single-initiator CTO action,
  // mirroring the build/release rule). All agents may read GitHub (github_list_*, get_file_contents).
  { pattern: 'github_push_files', requiredRole: 'cto', reason: 'Code pushes are CTO-only (single initiator).' },
  { pattern: 'github_create_pull_request', requiredRole: 'cto', reason: 'Opening PRs is CTO-only.' },
  { pattern: 'github_merge_pull_request', requiredRole: 'cto', reason: 'Merging PRs is CTO-only.' },
];

/** Return the required role for a tool name, or null if unrestricted. */
export function requiredRoleFor(toolName: string): { role: string; reason: string } | null {
  for (const r of GOVERNANCE) {
    if (r.pattern.endsWith('*')) {
      if (toolName.startsWith(r.pattern.slice(0, -1))) return { role: r.requiredRole, reason: r.reason };
    } else if (toolName === r.pattern) {
      return { role: r.requiredRole, reason: r.reason };
    }
  }
  return null;
}
