/**
 * Server-owned MCP presentation profiles selected by an exact endpoint route.
 * These profiles only remove advertised tools. The authenticated seat, connector allowlist,
 * lane curation, and each tool handler's authorization checks remain authoritative.
 */
export type FixedMcpToolProfile = 'read-only' | 'engineering';

export const FIXED_MCP_PROFILE_ROUTES = Object.freeze([
  Object.freeze({ path: '/mcp/profile/read-only', profile: 'read-only' as const }),
  Object.freeze({ path: '/mcp/profile/engineering', profile: 'engineering' as const }),
]);

const ENGINEERING_SEATS = Object.freeze(['cto', 'developer'] as const);

// Same bounded GitHub pack proposed by P2-02. It excludes merges, workflow dispatch, privileged
// knowledge, legal documents, memory writes, and business-system mutations.
const ENGINEERING_TOOL_NAMES = Object.freeze([
  'github_get_file_contents',
  'github_list_pull_requests',
  'github_create_branch',
  'github_create_or_update_file',
  'github_edit_file',
  'github_push_files',
  'github_create_pull_request',
  'github_pr_update',
  'github_list_workflow_runs',
  'github_workflow_run_get',
  'github_workflow_run_list_jobs',
  'github_pr_get',
  'github_pr_list_files',
  'github_pr_list_commits',
  'github_branch_get_protection',
  'github_repo_list_branches',
  'github_commit_get',
  'github_commit_compare',
] as const);

/**
 * Check profile membership against the canonical tool name, never an alias. The caller passes the
 * existing 13-tool baseline, while registerTool applies the connector and lane filters first.
 */
export function isFixedMcpProfileToolAllowed(
  profile: FixedMcpToolProfile,
  canonicalToolName: string,
  authenticatedSeat: string,
  readOnlyBaseline: readonly string[],
): boolean {
  if (readOnlyBaseline.includes(canonicalToolName)) return true;
  if (
    profile !== 'engineering' ||
    !ENGINEERING_SEATS.includes(authenticatedSeat as 'cto' | 'developer')
  ) {
    return false;
  }
  return ENGINEERING_TOOL_NAMES.some((name) => name === canonicalToolName);
}
