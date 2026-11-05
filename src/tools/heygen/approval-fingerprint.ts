import { createHash } from 'node:crypto';
import type { JsonWebKey } from 'node:crypto';

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
