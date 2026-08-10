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
  pattern: string;                 // exact name or 'prefix*'
  requiredRole: string | string[]; // agent id(s) that may execute, e.g. 'cto' or ['cto', 'developer']
  reason: string;
}

export const GOVERNANCE: GovRule[] = [
  // Customer.io administrative control plane. CRO can read and dry-run every bounded wrapper; live
  // configuration writes are additionally restricted in-handler to cto/exec and require an owner
  // approval reference. This central rule duplicates the fixed in-handler lane model for visibility.
  { pattern: 'cio_admin_read_*', requiredRole: ['cto', 'cro', 'exec'], reason: 'Customer.io administrative reads are limited to approved internal revenue/technology lanes.' },
  { pattern: 'cio_admin_write_*', requiredRole: ['cto', 'cro', 'exec'], reason: 'Customer.io admin writes require the approved internal lane; in-handler policy limits live execution to cto/exec with owner approval while CRO remains dry-run-only.' },
  // HeyGen credential pairing changes the durable OAuth token chain. Keep BOTH pairing controls
  // CTO-only by exact name; a broad heygen_* rule would incorrectly block approved internal data lanes.
  { pattern: 'heygen_pairing_start', requiredRole: 'cto', reason: 'Creating a HeyGen OAuth pairing session is CTO-owned credential administration.' },
  { pattern: 'heygen_pairing_status', requiredRole: 'cto', reason: 'HeyGen OAuth pairing state is CTO-only credential-administration metadata.' },
  // Prompt-avatar creation is the sole bounded credit-consuming HeyGen write. Exact CTO governance
  // is duplicated by an in-handler gate and a live premium-credit snapshot confirmation.
  { pattern: 'heygen_prompt_avatar_create', requiredRole: 'cto', reason: 'Credit-consuming HeyGen prompt-avatar creation is CTO-only and requires a live balance-bound confirmation.' },
  { pattern: 'heygen_avatar_look_name_update', requiredRole: ['cto', 'cro'], reason: 'Avatar Look renaming is a bounded, audited, non-credit metadata update for the CTO and CRO only.' },
  { pattern: 'heygen_reference_look_create', requiredRole: ['cto', 'exec', 'coo', 'cro', 'cpo', 'developer'], reason: 'Approved internal lanes may run dry-run reference-Look preflight; the handler independently restricts real creation to CTO plus owner grant.' },
  { pattern: 'heygen_video_agent_session_create_preflight', requiredRole: ['cto', 'exec', 'coo', 'cro', 'cpo', 'developer'], reason: 'Approved internal lanes may validate the fixed Video Agent chat-session contract; live execution remains CTO-only and feature-gated in-handler.' },
  { pattern: 'heygen_video_agent_feedback_send_preflight', requiredRole: ['cto', 'exec', 'coo', 'cro', 'cpo', 'developer'], reason: 'Approved internal lanes may validate the fixed planning-feedback contract; live execution remains CTO-only and feature-gated in-handler.' },
  { pattern: 'heygen_video_agent_generation_approve_preflight', requiredRole: ['cto', 'exec', 'coo', 'cro', 'cpo', 'developer'], reason: 'Approved internal lanes may validate the separate generation-approval contract; live execution remains CTO-only, owner-grant gated, and dark by default.' },
  { pattern: 'heygen_video_agent_session_stop_preflight', requiredRole: ['cto', 'exec', 'coo', 'cro', 'cpo', 'developer'], reason: 'Approved internal lanes may validate the fixed stop contract; live execution remains CTO-only and locally-owned-session gated.' },
  { pattern: 'heygen_asset_upload_preflight', requiredRole: ['cto', 'exec', 'coo', 'cro', 'cpo', 'developer'], reason: 'Approved internal lanes may validate the private-Azure fixed asset contract; live upload remains CTO-only and feature-gated.' },
  { pattern: 'heygen_translation_create_preflight', requiredRole: ['cto', 'exec', 'coo', 'cro', 'cpo', 'developer'], reason: 'Approved internal lanes may validate locked-master translation; live generation remains CTO-only and owner-grant gated.' },
  { pattern: 'heygen_proofread_create_preflight', requiredRole: ['cto', 'exec', 'coo', 'cro', 'cpo', 'developer'], reason: 'Approved internal lanes may validate proofread-first localization; live creation remains CTO-only and feature-gated.' },
  { pattern: 'heygen_proofread_generate_preflight', requiredRole: ['cto', 'exec', 'coo', 'cro', 'cpo', 'developer'], reason: 'Approved internal lanes may validate final proofread generation; live generation remains CTO-only and owner-grant gated.' },
  { pattern: 'heygen_speech_preview_create_preflight', requiredRole: ['cto', 'exec', 'coo', 'cro', 'cpo', 'developer'], reason: 'Approved internal lanes may validate bounded TTS preview; live synthesis remains CTO-only and owner-grant gated.' },
  { pattern: 'heygen_avatar_video_create', requiredRole: 'cto', reason: 'Credit-consuming direct HeyGen video creation is CTO-only, idempotent, and bound to live balance, ceiling, and reserve checks.' },
  { pattern: 'heygen_existing_video_ingest_qa', requiredRole: 'cto', reason: 'Existing-video secure ingestion writes private Blob artifacts and is CTO-owned.' },
  { pattern: 'heygen_video_wait_ingest_qa', requiredRole: 'cto', reason: 'HeyGen artifact ingestion writes private Blob artifacts and is CTO-owned.' },
  // Data reads and semantic voice search are centrally constrained to the same exact internal lanes
  // every handler re-checks. Exact names keep pairing/creation strictly narrower than this surface.
  { pattern: 'heygen_account_get', requiredRole: ['cto', 'exec', 'coo', 'cro', 'cpo', 'developer'], reason: 'HeyGen subscription data is limited to approved internal product/operations/engineering lanes.' },
  { pattern: 'heygen_diagnostics_get', requiredRole: ['cto', 'exec', 'coo', 'cro', 'cpo', 'developer'], reason: 'Non-secret HeyGen deployment and feature diagnostics are limited to approved internal lanes.' },
  { pattern: 'heygen_videos_list', requiredRole: ['cto', 'exec', 'coo', 'cro', 'cpo', 'developer'], reason: 'HeyGen subscription data is limited to approved internal product/operations/engineering lanes.' },
  { pattern: 'heygen_video_get', requiredRole: ['cto', 'exec', 'coo', 'cro', 'cpo', 'developer'], reason: 'HeyGen subscription data is limited to approved internal product/operations/engineering lanes.' },
  { pattern: 'heygen_video_agent_styles_list', requiredRole: ['cto', 'exec', 'coo', 'cro', 'cpo', 'developer'], reason: 'HeyGen subscription data is limited to approved internal product/operations/engineering lanes.' },
  { pattern: 'heygen_avatar_groups_list', requiredRole: ['cto', 'exec', 'coo', 'cro', 'cpo', 'developer'], reason: 'HeyGen avatar discovery is limited to approved internal product/operations/engineering lanes.' },
  { pattern: 'heygen_avatar_group_get', requiredRole: ['cto', 'exec', 'coo', 'cro', 'cpo', 'developer'], reason: 'HeyGen avatar discovery is limited to approved internal product/operations/engineering lanes.' },
  { pattern: 'heygen_avatar_looks_list', requiredRole: ['cto', 'exec', 'coo', 'cro', 'cpo', 'developer'], reason: 'HeyGen avatar discovery is limited to approved internal product/operations/engineering lanes.' },
  { pattern: 'heygen_avatar_look_get', requiredRole: ['cto', 'exec', 'coo', 'cro', 'cpo', 'developer'], reason: 'HeyGen avatar discovery is limited to approved internal product/operations/engineering lanes.' },
  { pattern: 'heygen_voices_list', requiredRole: ['cto', 'exec', 'coo', 'cro', 'cpo', 'developer'], reason: 'HeyGen voice discovery is limited to approved internal product/operations/engineering lanes.' },
  { pattern: 'heygen_voice_design', requiredRole: ['cto', 'exec', 'coo', 'cro', 'cpo', 'developer'], reason: 'HeyGen semantic voice search is limited to approved internal product/operations/engineering lanes.' },
  { pattern: 'heygen_video_statuses_get', requiredRole: ['cto', 'exec', 'coo', 'cro', 'cpo', 'developer'], reason: 'HeyGen video status reads are limited to approved internal lanes.' },
  { pattern: 'heygen_video_agent_sessions_list', requiredRole: ['cto', 'exec', 'coo', 'cro', 'cpo', 'developer'], reason: 'HeyGen session reads are limited to approved internal lanes.' },
  { pattern: 'heygen_video_agent_session_get', requiredRole: ['cto', 'exec', 'coo', 'cro', 'cpo', 'developer'], reason: 'HeyGen session reads are limited to approved internal lanes.' },
  { pattern: 'heygen_video_agent_session_videos_list', requiredRole: ['cto', 'exec', 'coo', 'cro', 'cpo', 'developer'], reason: 'HeyGen session video reads are limited to approved internal lanes.' },
  { pattern: 'heygen_video_agent_resource_get', requiredRole: ['cto', 'exec', 'coo', 'cro', 'cpo', 'developer'], reason: 'Sanitized HeyGen session-resource metadata is limited to approved internal lanes.' },
  { pattern: 'heygen_asset_get', requiredRole: ['cto', 'exec', 'coo', 'cro', 'cpo', 'developer'], reason: 'Sanitized HeyGen asset metadata is limited to approved internal lanes.' },
  { pattern: 'heygen_asset_statuses_get', requiredRole: ['cto', 'exec', 'coo', 'cro', 'cpo', 'developer'], reason: 'HeyGen asset status reads are limited to approved internal lanes.' },
  { pattern: 'heygen_brand_kits_list', requiredRole: ['cto', 'exec', 'coo', 'cro', 'cpo', 'developer'], reason: 'HeyGen brand metadata is limited to approved internal lanes.' },
  { pattern: 'heygen_brand_glossaries_list', requiredRole: ['cto', 'exec', 'coo', 'cro', 'cpo', 'developer'], reason: 'HeyGen brand glossary metadata is limited to approved internal lanes.' },
  { pattern: 'heygen_brand_glossary_get', requiredRole: ['cto', 'exec', 'coo', 'cro', 'cpo', 'developer'], reason: 'HeyGen brand glossary metadata is limited to approved internal lanes.' },
  { pattern: 'heygen_voice_get', requiredRole: ['cto', 'exec', 'coo', 'cro', 'cpo', 'developer'], reason: 'HeyGen voice metadata is limited to approved internal lanes.' },
  { pattern: 'heygen_translation_languages_list', requiredRole: ['cto', 'exec', 'coo', 'cro', 'cpo', 'developer'], reason: 'HeyGen translation metadata is limited to approved internal lanes.' },
  { pattern: 'heygen_translations_list', requiredRole: ['cto', 'exec', 'coo', 'cro', 'cpo', 'developer'], reason: 'HeyGen translation metadata is limited to approved internal lanes.' },
  { pattern: 'heygen_translation_get', requiredRole: ['cto', 'exec', 'coo', 'cro', 'cpo', 'developer'], reason: 'HeyGen translation metadata is limited to approved internal lanes.' },
  { pattern: 'heygen_translation_statuses_get', requiredRole: ['cto', 'exec', 'coo', 'cro', 'cpo', 'developer'], reason: 'HeyGen translation metadata is limited to approved internal lanes.' },
  { pattern: 'heygen_proofread_get', requiredRole: ['cto', 'exec', 'coo', 'cro', 'cpo', 'developer'], reason: 'HeyGen proofread metadata is limited to approved internal lanes.' },
  { pattern: 'heygen_avatar_video_operation_get', requiredRole: ['cto', 'exec', 'coo', 'cro', 'cpo', 'developer'], reason: 'HeyGen operation state is limited to approved internal lanes.' },
  { pattern: 'heygen_owner_approval_status_get', requiredRole: ['cto', 'exec', 'coo', 'cro', 'cpo', 'developer'], reason: 'HeyGen owner-approval availability is limited to approved internal lanes and exposes no grant material.' },
  { pattern: 'heygen_reference_look_operation_get', requiredRole: ['cto', 'exec', 'coo', 'cro', 'cpo', 'developer'], reason: 'HeyGen reference-Look operation state is limited to approved internal lanes.' },
  // Azure control-plane tools (ITEM #2) are CTO-only: infra is CTO-owned. Covers the Phase A read
  // tools (azure_jobs_list / azure_job_executions / azure_logs_query / azure_search_index_stats /
  // azure_containerapp_get / azure_resource_list) AND every future Phase B write tool (azure_job_* /
  // azure_containerapp_set_env / azure_search_*_upsert) by the same prefix, so a write tool can never
  // ship un-gated by omission. Visible to all agents; executable only by the cto lane.
  { pattern: 'azure_*', requiredRole: 'cto', reason: 'Azure control-plane (infra) is CTO-owned; read + write both CTO-only.' },
  // Builds / CI (Depot) -- widened 2026-07-26 (Matt/CEO direct directive): the 'otchealth-dev'
  // Copilot custom agent (caller_agent='developer') needs full read+write Depot capability to
  // actually build the apps it's responsible for, not just observe. Previously CTO-only
  // single-initiator; now cto OR developer. NOTE this prefix covers the ENTIRE depot_* surface,
  // including destructive ops (project-delete, registry-images-delete, token-delete,
  // workflow-cancel, job-cancel, run-cancel, project-reset) as well as trigger-build -- deliberately
  // "full capable" per the directive, not narrowed to trigger-build alone. cto remains the only
  // role for every OTHER infra surface (azure_*, netlify_*, cloudflare_*, stripe_*) -- those were
  // not part of this directive and stay single-initiator.
  { pattern: 'depot_*', requiredRole: ['cto', 'developer'], reason: 'iOS/CI builds + TestFlight uploads are cto/developer-only (developer widened to full Depot read+write 2026-07-26 per Matt/CEO directive; previously CTO-only single-initiator).' },
  { pattern: 'build_*', requiredRole: 'cto', reason: 'Build/release dispatch is CTO-only.' },
  { pattern: 'release_*', requiredRole: 'cto', reason: 'Release cutovers are CTO-only.' },
  // DNS / infra writes are CTO-only (charter: DNS + infra changes are CTO-owned).
  { pattern: 'cloudflare_create_dns_record', requiredRole: 'cto', reason: 'DNS changes are CTO-owned infrastructure.' },
  // GitHub writes -- widened 2026-07-26 (Matt/CEO direct directive, same as depot_* above): the
  // 'otchealth-dev' Copilot custom agent needs full read+write GitHub capability (push, PR, merge,
  // dispatch) to actually ship code, not just read it. Previously CTO-only single-initiator
  // ("code pushes are a single-initiator CTO action"); now cto OR developer for every GitHub write
  // in this list. All agents may already read GitHub (github_list_*, get_file_contents) -- unaffected.
  { pattern: 'github_push_files', requiredRole: ['cto', 'developer'], reason: 'Code pushes: cto/developer-only (developer widened to full write 2026-07-26 per Matt/CEO directive; previously CTO-only single-initiator).' },
  { pattern: 'github_create_pull_request', requiredRole: ['cto', 'developer'], reason: 'Opening PRs: cto/developer-only (widened 2026-07-26 per Matt/CEO directive).' },
  { pattern: 'github_pr_update', requiredRole: ['cto', 'developer'], reason: 'Updating a PR (title/body/base/state, incl. close/reopen) is a write_simple GitHub write, so the write_orchestrated default CTO gate does NOT cover it; explicit rule required. Widened 2026-07-26 per Matt/CEO directive to cto/developer.' },
  { pattern: 'github_merge_pull_request', requiredRole: ['cto', 'developer'], reason: 'Merging PRs: cto/developer-only (widened 2026-07-26 per Matt/CEO directive).' },
  // ===== FULL READ+WRITE WAVE: write-tool role gates (CTO = the operator connector identity) =====
  // GitHub writes (single-initiator, mirrors existing push/PR/merge rules) -- widened alongside them.
  { pattern: 'github_create_branch', requiredRole: ['cto', 'developer'], reason: 'Branch creation: cto/developer-only (widened 2026-07-26 per Matt/CEO directive).' },
  { pattern: 'github_create_or_update_file', requiredRole: ['cto', 'developer'], reason: 'Direct file commits: cto/developer-only (widened 2026-07-26 per Matt/CEO directive).' },
  { pattern: 'github_edit_file', requiredRole: ['cto', 'developer'], reason: 'Surgical in-place file edits (old_str/new_str) are a direct code write, same risk class as github_create_or_update_file. It is category write_simple, so the write_orchestrated default CTO gate does NOT cover it; this explicit rule is required. Widened 2026-07-26 per Matt/CEO directive to cto/developer.' },
  { pattern: 'github_create_issue', requiredRole: ['cto', 'developer'], reason: 'Gateway issue creation: cto/developer-only (widened 2026-07-26 per Matt/CEO directive).' },
  { pattern: 'github_comment_on_issue', requiredRole: ['cto', 'developer'], reason: 'Gateway issue/PR comments: cto/developer-only (widened 2026-07-26 per Matt/CEO directive).' },
  { pattern: 'github_add_labels', requiredRole: ['cto', 'developer'], reason: 'Label writes: cto/developer-only (widened 2026-07-26 per Matt/CEO directive).' },
  { pattern: 'github_create_release', requiredRole: ['cto', 'developer'], reason: 'Releases (single initiator): cto/developer-only (widened 2026-07-26 per Matt/CEO directive).' },
  { pattern: 'github_dispatch_workflow', requiredRole: ['cto', 'developer'], reason: 'Workflow dispatch triggers builds/deploys: cto/developer-only (widened 2026-07-26 per Matt/CEO directive).' },
  // Netlify deploy + env + hooks are CTO-owned infra. NOT part of the 2026-07-26 directive (which
  // was scoped to GitHub + Depot specifically) -- stays CTO-only.
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

/** Return the required role(s) for a tool name, or null if unrestricted. */
export function requiredRoleFor(toolName: string): { role: string | string[]; reason: string } | null {
  for (const r of GOVERNANCE) {
    if (r.pattern.endsWith('*')) {
      if (toolName.startsWith(r.pattern.slice(0, -1))) return { role: r.requiredRole, reason: r.reason };
    } else if (toolName === r.pattern) {
      return { role: r.requiredRole, reason: r.reason };
    }
  }
  return null;
}

/** True when callerAgent satisfies a GovRule's requiredRole (single string or a list of roles). */
export function roleAllows(role: string | string[], callerAgent: string): boolean {
  return Array.isArray(role) ? role.includes(callerAgent) : role === callerAgent;
}
