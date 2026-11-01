const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_WORKFLOW_IDS = 25;

/** Parse only the dedicated nonsecret COO allowlist setting. */
export function parseCooWorkflowMetadataAllowlist(raw: string | undefined): string[] {
  if (typeof raw !== 'string' || raw.length === 0) throw new Error('coo_workflow_allowlist_invalid');
  const ids = raw.split(',').map((value) => value.trim());
  if (ids.length < 1 || ids.length > MAX_WORKFLOW_IDS ||
      ids.some((id) => !ID_PATTERN.test(id)) || new Set(ids).size !== ids.length) {
    throw new Error('coo_workflow_allowlist_invalid');
  }
  return ids;
}

export function authorizedCooWorkflowMetadataIds(): Set<string> {
  return new Set(parseCooWorkflowMetadataAllowlist(process.env.COO_N8N_WORKFLOW_ID_ALLOWLIST));
}
