export type BrowserCapability = 'public_read' | 'authenticated_read' | 'draft_write' | 'committed_write';

export interface BrowserAgentEnrollment {
  callerAgent: string;
  profileLabel: string;
  allowedHosts: readonly string[];
  capabilities: readonly BrowserCapability[];
}

/**
 * The broker is intentionally enrollment-first: an agent receives only the capabilities
 * recorded here, in an isolated browser identity. New agents and capabilities are added
 * explicitly rather than inheriting ambient browser authority.
 */
const ENROLLMENTS: readonly BrowserAgentEnrollment[] = [
  {
    callerAgent: 'wefunder-campaign-director',
    profileLabel: 'wefunder_campaign_director',
    allowedHosts: ['wefunder.com', 'help.wefunder.com', 'otchealth.app'],
    capabilities: ['public_read'],
  },
];

export function resolveBrowserEnrollment(callerAgent: string | undefined | null): BrowserAgentEnrollment | null {
  if (!callerAgent) return null;
  return ENROLLMENTS.find((entry) => entry.callerAgent === callerAgent) ?? null;
}

export function enrollmentAllows(enrollment: BrowserAgentEnrollment, capability: BrowserCapability): boolean {
  return enrollment.capabilities.includes(capability);
}

/** Validates URLs against the enrolled agent's explicit host allowlist. */
export function validateEnrollmentTargets(enrollment: BrowserAgentEnrollment, targets: unknown): { ok: true; urls: URL[] } | { ok: false; reason: string } {
  if (!Array.isArray(targets) || targets.length === 0 || targets.length > 12) {
    return { ok: false, reason: 'targets must contain 1-12 HTTPS URLs' };
  }
  const urls: URL[] = [];
  for (const raw of targets) {
    if (typeof raw !== 'string' || raw.length > 2048) return { ok: false, reason: 'target must be a bounded URL string' };
    const authority = /^https:\/\/([^/?#]+)/i.exec(raw)?.[1] ?? '';
    if (authority.includes('@') || authority.includes(':')) return { ok: false, reason: 'target must not contain userinfo, an IP literal, or an explicit port' };
    let url: URL;
    try { url = new URL(raw); } catch { return { ok: false, reason: 'target is not a valid URL' }; }
    if (url.protocol !== 'https:' || url.username || url.password || url.port || !enrollment.allowedHosts.includes(url.hostname.toLowerCase())) {
      return { ok: false, reason: 'target host is not enrolled for this browser lane' };
    }
    urls.push(url);
  }
  return { ok: true, urls };
}

export function browserEnrollmentSnapshot(enrollment: BrowserAgentEnrollment): { caller_agent: string; profile: string; capabilities: readonly BrowserCapability[] } {
  return { caller_agent: enrollment.callerAgent, profile: enrollment.profileLabel, capabilities: enrollment.capabilities };
}
