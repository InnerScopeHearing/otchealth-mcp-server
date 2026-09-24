/**
 * Request-scoped MCP tool discovery. The class is a caller-controlled presentation selector only:
 * the authenticated caller identity and every handler authorization check remain independent.
 *
 * The gateway is stateless, so clients must send this header on every /mcp POST, including
 * tools/list and tools/call. Missing, repeated, malformed, and unrecognized values select the
 * read-only baseline.
 */
export const TASK_CLASS_HEADER = 'x-otc-task-class';

export type TaskClass = 'read_only' | 'engineering';

const ENGINEERING_SEATS = new Set(['cto', 'developer']);

// Bounded coding and review pack. It intentionally excludes merges, workflow dispatch, privileged
// knowledge, legal document tools, memory writes, and business-system mutations.
const ENGINEERING_TOOLS = new Set([
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
]);

export function parseTaskClassHeader(value: unknown): TaskClass {
  if (typeof value !== 'string') return 'read_only';
  const normalized = value.trim().toLowerCase();
  return normalized === 'engineering' ? 'engineering' : 'read_only';
}

function candidateToolNames(
  taskClass: unknown,
  authenticatedSeat: string,
  readOnlyBaseline: readonly string[],
): Set<string> {
  const candidates = new Set(readOnlyBaseline);
  if (parseTaskClassHeader(taskClass) === 'engineering' && ENGINEERING_SEATS.has(authenticatedSeat)) {
    for (const name of ENGINEERING_TOOLS) candidates.add(name);
  }
  return candidates;
}

/**
 * Return the selected class pack intersected with the authenticated seat's existing allowlist.
 * The runtime registration path also applies the existing connector and optional lane-curation
 * gates before checking class membership, so the advertised set is never widened by this selector.
 */
export function selectTaskScopedToolPack(options: {
  taskClass: unknown;
  authenticatedSeat: string;
  authenticatedSeatAllowlist: ReadonlySet<string>;
  readOnlyBaseline: readonly string[];
}): readonly string[] {
  const candidates = candidateToolNames(
    options.taskClass,
    options.authenticatedSeat,
    options.readOnlyBaseline,
  );
  return [...candidates]
    .filter((name) => options.authenticatedSeatAllowlist.has(name))
    .sort();
}

/** Fast per-tool membership check used after the existing seat gates in registerTool(). */
export function isTaskScopedToolInPack(
  taskClass: unknown,
  authenticatedSeat: string,
  toolName: string,
  readOnlyBaseline: ReadonlySet<string>,
): boolean {
  if (readOnlyBaseline.has(toolName)) return true;
  return parseTaskClassHeader(taskClass) === 'engineering'
    && ENGINEERING_SEATS.has(authenticatedSeat)
    && ENGINEERING_TOOLS.has(toolName);
}
