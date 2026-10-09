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

