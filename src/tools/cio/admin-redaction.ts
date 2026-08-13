import { createHash } from 'node:crypto';

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

const SENSITIVE_KEY = /(authorization|token|secret|password|api[_-]?key|headers?|request|response|payload|body|content|attributes?|customer|profile|person|recipient|email|phone|address|ip_addr|ip_address)/i;
const TEXT_KEY = /(name|description|title|subtitle|subject|logo_path|value_attribute|funnel_start_event|goal_event)/i;

export function redactCioAdminInputForLog(input: Record<string, unknown>): unknown {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (key === 'owner_approval_ref') {
      out.owner_approval_ref_sha256 = sha256(String(value ?? ''));
      continue;
    }
    if (SENSITIVE_KEY.test(key)) {
      out[`${key}_sha256`] = sha256(JSON.stringify(value ?? null));
      continue;
    }
    if (TEXT_KEY.test(key) && typeof value === 'string') {
      out[`${key}_sha256`] = sha256(value);
      continue;
    }
    out[key] = value;
  }
  return out;
}

/**
 * Audit-log payloads can contain actor IP/email, changed values, and request snapshots.
 * Keep event identity/timing while replacing sensitive subtrees with deterministic fingerprints.
 */
export function redactCioAuditPayload(value: unknown, key = ''): unknown {
  if (SENSITIVE_KEY.test(key)) {
    return { redacted: true, sha256: sha256(JSON.stringify(value ?? null)) };
  }
  if (Array.isArray(value)) return value.map((item) => redactCioAuditPayload(item));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
      out[childKey] = redactCioAuditPayload(childValue, childKey);
    }
    return out;
  }
  if (typeof value === 'string') {
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) || /^\+?\d[\d\s().-]{6,}$/.test(value)) {
      return { redacted: true, sha256: sha256(value) };
    }
  }
  return value;
}

export function approvalFingerprint(ownerApprovalRef: string): string {
  return sha256(ownerApprovalRef);
}
