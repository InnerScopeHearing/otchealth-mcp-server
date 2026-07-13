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
  // Azure control-plane tools (ITEM #2) are CTO-only: infra is CTO-owned. Covers the Phase A read
  // tools (azure_jobs_list / azure_job_executions / azure_logs_query / azure_search_index_stats /
  // azure_containerapp_get / azure_resource_list) AND every future Phase B write tool (azure_job_* /
  // azure_containerapp_set_env / azure_search_*_upsert) by the same prefix, so a write tool can never
  // ship un-gated by omission. Visible to all agents; executable only by the cto lane.
  { pattern: 'azure_*', requiredRole: 'cto', reason: 'Azure control-plane (infra) is CTO-owned; read + write both CTO-only.' },
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
  { pattern: 'github_pr_update', requiredRole: 'cto', reason: 'Updating a PR (title/body/base/state, incl. close/reopen) is a CTO-only PR write. It is category write_simple, so the write_orchestrated default CTO gate does NOT cover it; without this explicit rule any write-enabled lane could execute it. Added when the connector-surface widen exposed it on the DCR surface (2026-07-12).' },
  { pattern: 'github_merge_pull_request', requiredRole: 'cto', reason: 'Merging PRs is CTO-only.' },
  // ===== FULL READ+WRITE WAVE: write-tool role gates (CTO = the operator connector identity) =====
  // GitHub writes (single-initiator, mirrors existing push/PR/merge rules).
  { pattern: 'github_create_branch', requiredRole: 'cto', reason: 'Branch creation is CTO-only (single initiator).' },
  { pattern: 'github_create_or_update_file', requiredRole: 'cto', reason: 'Direct file commits are CTO-only.' },
  { pattern: 'github_edit_file', requiredRole: 'cto', reason: 'Surgical in-place file edits (old_str/new_str) are a direct code write, same risk class as github_create_or_update_file. It is category write_simple, so the write_orchestrated default CTO gate does NOT cover it; this explicit rule is required or any write-enabled lane could edit files.' },
  { pattern: 'github_create_issue', requiredRole: 'cto', reason: 'Gateway issue creation is CTO-only.' },
  { pattern: 'github_comment_on_issue', requiredRole: 'cto', reason: 'Gateway issue/PR comments are CTO-only.' },
  { pattern: 'github_add_labels', requiredRole: 'cto', reason: 'Label writes are CTO-only.' },
  { pattern: 'github_create_release', requiredRole: 'cto', reason: 'Releases are CTO-only (single initiator).' },
  { pattern: 'github_dispatch_workflow', requiredRole: 'cto', reason: 'Workflow dispatch triggers builds/deploys; CTO-only.' },
  // Netlify deploy + env + hooks are CTO-owned infra.
  { pattern: 'netlify_trigger_deploy', requiredRole: 'cto', reason: 'Production deploys are CTO-only.' },
  { pattern: 'netlify_set_env_var', requiredRole: 'cto', reason: 'Env-var changes affect all deploys; CTO-only.' },
  { pattern: 'netlify_create_deploy_hook', requiredRole: 'cto', reason: 'Deploy hooks grant unauthenticated build triggers; CTO-only.' },
  // Cloudflare DNS update/delete match the existing create-dns CTO rule (DNS = infra).
  { pattern: 'cloudflare_update_dns_record', requiredRole: 'cto', reason: 'DNS changes are CTO-owned infrastructure.' },
  { pattern: 'cloudflare_delete_dns_record', requiredRole: 'cto', reason: 'DNS deletions are CTO-owned infrastructure; irreversible.' },
  // Stripe irreversible money movement / charge instruments are CTO-gated (promote to cfo lane when provisioned).
  { pattern: 'stripe_create_refund', requiredRole: 'cto', reason: 'Refunds are irreversible money movement.' },
  { pattern: 'stripe_cancel_subscription', requiredRole: 'cto', reason: 'Cancelling a subscription terminates recurring revenue.' },
  { pattern: 'stripe_create_payment_link', requiredRole: 'cto', reason: 'Payment links are public charge instruments.' },
  { pattern: 'stripe_create_invoice', requiredRole: 'cto', reason: 'Invoices with auto_advance can trigger collection.' },
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
