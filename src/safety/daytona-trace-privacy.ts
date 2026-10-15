/** Signed preview credentials occur in hostnames and paths, not only queries.
 * Exclude the vendor/private preview transport from APM and trace propagation.
 * This is a pure filter: never log its input or parse errors.
 */
export function daytonaTracePrivacyOptions(previewDomain = '') {
  const configured = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(previewDomain) ? previewDomain : undefined;
  const blocked = (raw: string): boolean => {
    if (/\/signed-preview-url(?:[/?#]|$)/.test(raw)) return true;
    try {
      const host = new URL(raw).hostname.toLowerCase().replace(/\.$/, '');
      return host === 'daytona.io' || host.endsWith('.daytona.io') || host === 'daytona.works' || host.endsWith('.daytona.works')
        || host === 'daytonaproxy01.net' || host.endsWith('.daytonaproxy01.net')
        || Boolean(configured && (host === configured || host.endsWith(`.${configured}`)));
    } catch { return false; }
  };
  const client = { blocklist: [blocked], propagationBlocklist: [blocked] };
  return { http: { client }, undici: client };
}
