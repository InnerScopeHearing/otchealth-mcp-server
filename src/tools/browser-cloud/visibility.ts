/** Apply the existing CTO-only connector catalog rule for persistent-profile tools. */
export function addCtoExistingProfileTools(tools: Set<string>, lane: string, connectorToolsetOverride?: string): void {
  if (lane !== 'cto') {
    tools.delete('browser_cloud_cto_profile_discover_existing');
    tools.delete('browser_cloud_cto_profile_bind_existing');
    return;
  }
  if (connectorToolsetOverride) return;
  tools.add('browser_cloud_cto_profile_discover_existing');
  tools.add('browser_cloud_cto_profile_bind_existing');
}
