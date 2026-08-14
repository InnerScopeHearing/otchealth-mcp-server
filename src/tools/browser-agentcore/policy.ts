const ALLOWED_HOSTS = new Set(['wefunder.com', 'help.wefunder.com', 'otchealth.app']);
const BLOCKED = /\b(login|log\s*in|sign\s*in|password|passcode|one[-\s]?time|verification\s*code|mfa|2fa|captcha|publish|submit|save|edit|update|invite|message|communicat|visibility|safe|security\s*term|offering\s*term|valuation|price|payment|invest|kyc|accredit|bank|tax|e[-\s]?sign|signature|session\s*save|profile\s*save)\b/i;

export const MAX_TARGETS = 12;
export const MAX_SECONDS = 300;

export type TargetValidation = { ok: true; urls: URL[] } | { ok: false; reason: string };

export function validatePublicTargets(targets: unknown): TargetValidation {
  if (!Array.isArray(targets) || targets.length === 0 || targets.length > MAX_TARGETS) {
    return { ok: false, reason: `targets must contain 1-${MAX_TARGETS} HTTPS URLs` };
  }
  const urls: URL[] = [];
  for (const raw of targets) {
    if (typeof raw !== 'string' || raw.length > 2048) return { ok: false, reason: 'target must be a bounded URL string' };
    // WHATWG URL normalizes an explicit default port (https://host:443) to an empty URL.port.
    // Check raw authority first so no caller can bypass the no-port rule through normalization.
    const authority = /^https:\/\/([^/?#]+)/i.exec(raw)?.[1] ?? '';
    if (authority.includes('@') || authority.includes(':')) {
      return { ok: false, reason: 'target must not contain userinfo, an IP literal, or an explicit port' };
    }
    let url: URL;
    try { url = new URL(raw); } catch { return { ok: false, reason: 'target is not a valid URL' }; }
    if (url.protocol !== 'https:' || url.username || url.password || url.port || !ALLOWED_HOSTS.has(url.hostname.toLowerCase())) {
      return { ok: false, reason: 'target host is not in the strict public allowlist' };
    }
    urls.push(url);
  }
  return { ok: true, urls };
}

export function rejectSensitiveIntent(value: unknown): string | null {
  const text = JSON.stringify(value ?? '').slice(0, 10_000);
  return BLOCKED.test(text) ? 'requested intent is outside the read-only browser boundary' : null;
}

export class ProfileLeaseStore {
  private readonly leases = new Set<string>();
  acquire(provider: string, role: string, profile: string): boolean {
    const key = `${provider}:${role}:${profile}`;
    if (this.leases.has(key)) return false;
    this.leases.add(key);
    return true;
  }
  release(provider: string, role: string, profile: string): void { this.leases.delete(`${provider}:${role}:${profile}`); }
}

export interface RedactedReceipt {
  host: string;
  status: number | null;
  title: string | null;
  final_host: string | null;
  cleanup_success: boolean;
  observed_at: string;
}

export function redactedReceipt(target: URL, status: number | null, title: string | null, finalUrl: string | null, cleanupSuccess = true): RedactedReceipt {
  let finalHost: string | null = null;
  try { finalHost = finalUrl ? new URL(finalUrl).hostname : null; } catch { finalHost = null; }
  return {
    host: target.hostname,
    status,
    title: title?.slice(0, 160) ?? null,
    final_host: finalHost,
    cleanup_success: cleanupSuccess,
    observed_at: new Date().toISOString(),
  };
}
