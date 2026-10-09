/**
 * Company lanes approved to operate the bounded GitHub ship cycle.
 *
 * This is intentionally not a blanket `github_*` grant. The toolset below is the exact
 * branch/file/PR/issue/Actions surface that was already curated for the CTO ship lane. It excludes
 * credential or secret access, repository/organization administration, release administration,
 * destructive content/label/milestone operations, the fixed GraphRAG receipt, failed CI log text,
 * and the isolated Make pilot broker.
 *
 * Keep this list as the single source of truth for both connector visibility and execution-time
 * governance. Unknown, external, and pilot identities are deliberately absent.
 */
export const COMPANY_GITHUB_OPERATOR_LANES = [
  'cto',
  'developer',
  'cfo',
  'clo',
  'clo-personal',
  'coo',
  'cro',
  'cpo',
  'cco',
  'exec',
  'wefunder-campaign-director',
] as const;

export type CompanyGitHubOperatorLane = (typeof COMPANY_GITHUB_OPERATOR_LANES)[number];

export function isCompanyGitHubOperatorLane(lane: string): lane is CompanyGitHubOperatorLane {
  return (COMPANY_GITHUB_OPERATOR_LANES as readonly string[]).includes(lane);
}

/** Company repository owners reachable through the shared operator surface. */
export const COMPANY_GITHUB_ALLOWED_OWNERS = ['InnerScopeHearing'] as const;

export function isCompanyGitHubAllowedOwner(owner: unknown): owner is string {
  return typeof owner === 'string'
    && (COMPANY_GITHUB_ALLOWED_OWNERS as readonly string[]).some((allowed) => allowed.toLowerCase() === owner.toLowerCase());
}

/**
 * Existing repository-name carveout for direct GitHub writes. This preserves the gateway's
 * MedReview/PHI repository policy; it is a name-based boundary, not a PHI content detector.
 */
export function isGitHubWriteCarvedOutRepository(repo: unknown): repo is string {
  return typeof repo === 'string' && (/^medreview/i.test(repo) || /phi/i.test(repo));
}

/** Exact GitHub surface shared by every approved company operator lane. */
export const GITHUB_OPERATOR_TOOLSET = [
  // Repository content and high-level work discovery.
  'github_get_file_contents',
  'github_list_pull_requests',
  'github_issue_list',

  // Branch, file, pull-request, and ref lifecycle.
  'github_create_branch',
  'github_create_or_update_file',
  'github_edit_file',
  'github_push_files',
  'github_create_pull_request',
  'github_pr_update',
  'github_pr_update_branch',
  'github_ref_delete',
  'github_merge_pull_request',
  'github_pr_create_review',

  // Issue collaboration.
  'github_comment_on_issue',
  'github_create_issue',
  'github_issue_get',
  'github_issue_update',

  // Actions dispatch, rerun, and inspection.
  'github_dispatch_workflow',
  'github_list_workflow_runs',
  'github_workflow_run_get',
  'github_workflow_run_rerun',
  'github_workflow_run_list_jobs',

  // Review and merge-decision reads.
  'github_pr_get',
  'github_pr_list_files',
  'github_pr_list_commits',
  'github_branch_get_protection',
  'github_repo_list_branches',
  'github_commit_get',
  'github_commit_compare',
] as const;

export function isGitHubOperatorTool(toolName: string): boolean {
  return (GITHUB_OPERATOR_TOOLSET as readonly string[]).includes(toolName);
}

/** Mutating subset that must always carry an explicit company-operator governance rule. */
export const GITHUB_OPERATOR_WRITE_TOOLS = [
  'github_create_branch',
  'github_create_or_update_file',
  'github_edit_file',
  'github_push_files',
  'github_create_pull_request',
  'github_pr_update',
  'github_pr_update_branch',
  'github_ref_delete',
  'github_merge_pull_request',
  'github_pr_create_review',
  'github_comment_on_issue',
  'github_create_issue',
  'github_issue_update',
  'github_dispatch_workflow',
  'github_workflow_run_rerun',
] as const;

/**
 * GitHub mutations outside the shared 29-tool surface that retain the narrower CTO/Developer
 * boundary. All 14 write_simple entries require explicit governance because they do not receive
 * registry.ts's high-risk default. Release creation keeps its pre-existing CTO/Developer rule.
 * Destructive label/release deletion is deliberately absent and retains the write_orchestrated
 * CTO-only default.
 */
export const GITHUB_CTO_DEVELOPER_ADJACENT_WRITE_TOOLS = [
  'github_add_labels',
  'github_git_tag_create',
  'github_issue_add_assignees',
  'github_issue_lock',
  'github_issue_unlock',
  'github_label_create',
  'github_label_update',
  'github_milestone_create',
  'github_milestone_update',
  'github_pr_request_reviewers',
  'github_ref_create',
  'github_ref_update',
  'github_create_release',
  'github_release_update',
  'github_workflow_enable',
] as const;

/**
 * Every direct repository mutation registered by src/tools/github, excluding the isolated Make
 * broker. The broker has its own fixed-repository validator and cannot address an arbitrary owner.
 *
 * Keep the owner and protected-content boundaries keyed to this exact list rather than to a
 * github_* prefix: the prefix also contains read-only tools and the separately governed broker.
 */
export const GITHUB_REPOSITORY_WRITE_TOOLS = [
  ...GITHUB_OPERATOR_WRITE_TOOLS,
  ...GITHUB_CTO_DEVELOPER_ADJACENT_WRITE_TOOLS,
  'github_contents_delete_file',
  'github_label_delete',
  'github_milestone_delete',
  'github_release_delete',
  'github_workflow_disable',
  'github_workflow_run_cancel',
] as const;

export function isGitHubRepositoryWriteTool(toolName: string): boolean {
  return (GITHUB_REPOSITORY_WRITE_TOOLS as readonly string[]).includes(toolName);
}

/**
 * Repository mutations that publish caller-supplied prose or file content to a company-wide GitHub
 * destination. The dedicated clo-personal lane may still perform bounded metadata writes, but it
 * may not use these broad content transports. Exec retains clean engineering writes under the
 * recursive protected-content scan.
 */
export const GITHUB_CONTENT_BEARING_WRITE_TOOLS = [
  'github_create_branch',
  'github_create_or_update_file',
  'github_edit_file',
  'github_push_files',
  'github_create_pull_request',
  'github_pr_update',
  'github_merge_pull_request',
  'github_pr_create_review',
  'github_comment_on_issue',
  'github_create_issue',
  'github_issue_update',
  'github_dispatch_workflow',
  'github_contents_delete_file',
  'github_create_release',
  'github_git_tag_create',
  'github_label_create',
  'github_label_update',
  'github_milestone_create',
  'github_milestone_update',
  'github_release_update',
] as const;

export function isGitHubContentBearingWriteTool(toolName: string): boolean {
  return (GITHUB_CONTENT_BEARING_WRITE_TOOLS as readonly string[]).includes(toolName);
}
