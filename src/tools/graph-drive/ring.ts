/**
 * Folder-name ring-gating for the OneDrive/Graph Drive three-folder exchange tools (graph_drive_*).
 *
 * The exchange folders are named "<ROLE> Outgoing" / "<ROLE> Incoming" / "<ROLE> Processed" at the
 * drive root (e.g. "CLO Outgoing", "CTO Incoming"). The rule (task brief): a caller may only touch
 * ITS OWN role's folders by default — a "cto" caller defaults to the CTO folders, a "clo" caller to
 * the CLO folders. One role must NEVER browse another role's OneDrive folders by default.
 *
 * Enforcement is a case-insensitive match between the caller's lane and the ROLE token that the
 * target folder path starts with. A caller with no lane identity is refused outright.
 *
 * There is deliberately NO "browse any role" escape hatch here: the brief says "not hardcoded to one
 * role" (the folder is a parameter) AND "do NOT let one role browse another role's folders by
 * default". Both hold: the folder is caller-supplied, but it must resolve to the caller's own role.
 * The clo-personal lane is treated as the CLO role for drive purposes (its OneDrive exchange folders
 * are the CLO folders); this keeps the personal-legal lane from being stranded without a drive.
 */

/** Map a caller lane to the role token(s) it owns in OneDrive folder names. */
const LANE_TO_ROLES: Record<string, string[]> = {
  cto: ['cto'],
  cfo: ['cfo'],
  clo: ['clo'],
  'clo-personal': ['clo'], // the personal-legal lane shares the CLO OneDrive exchange folders
  coo: ['coo'],
  cro: ['cro'],
  cpo: ['cpo'],
  cco: ['cco'],
  exec: ['cto', 'cfo', 'clo', 'coo', 'cro', 'cpo', 'cco'], // unified chief owns every role's folders
  developer: ['developer', 'dev'],
};

/** The leading role token of a folder path, e.g. "CLO Outgoing/sub" -> "clo". null if none. */
export function roleOfFolder(folderPath: string): string | null {
  const first = folderPath.replace(/^\/+/, '').split('/')[0] ?? '';
  const token = first.trim().split(/\s+/)[0] ?? '';
  return token ? token.toLowerCase() : null;
}

/** The roles a caller lane is allowed to address. Empty when the lane is unknown/absent. */
export function rolesForLane(caller: string | undefined | null): string[] {
  if (!caller) return [];
  return LANE_TO_ROLES[caller.toLowerCase()] ?? [];
}

/**
 * Pure gate predicate, exported for unit testing without the MCP server. A caller may address a
 * folder only when the folder's leading role token is one of the caller's owned roles.
 */
export function isDriveFolderAllowed(caller: string | undefined | null, folderPath: string): boolean {
  const roles = rolesForLane(caller);
  if (!roles.length) return false;
  const folderRole = roleOfFolder(folderPath);
  if (!folderRole) return false;
  return roles.includes(folderRole);
}
