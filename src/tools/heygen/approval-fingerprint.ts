import { createHash } from 'node:crypto';
import type { JsonWebKey } from 'node:crypto';

function sha256(value: string): string | undefined {
  return value ? createHash('sha256').update(value, 'utf8').digest('hex') : undefined;
}

export function heyGenPublicJwkFingerprint(publicJwkText: string): string | undefined {
  if (!publicJwkText) return undefined;
  try {
    const jwk = JSON.parse(publicJwkText) as JsonWebKey;
    if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || !jwk.kid || !jwk.x || !jwk.y || jwk.d) return undefined;
    return createHash('sha256')
      .update(JSON.stringify({ crv: 'P-256', kid: jwk.kid, kty: 'EC', x: jwk.x, y: jwk.y }))
      .digest('hex');
  } catch {
    return undefined;
  }
}

export function heyGenApprovalCompatibilityFingerprints(input: {
  publicJwk: string;
  contextSecret: string;
  handleSecret: string;
  callbackSecret: string;
}): {
  public_jwk_sha256?: string;
  context_secret_sha256?: string;
  handle_secret_sha256?: string;
  callback_secret_sha256?: string;
} {
  return {
    public_jwk_sha256: heyGenPublicJwkFingerprint(input.publicJwk),
    context_secret_sha256: sha256(input.contextSecret),
    handle_secret_sha256: sha256(input.handleSecret),
    callback_secret_sha256: sha256(input.callbackSecret),
  };
}
