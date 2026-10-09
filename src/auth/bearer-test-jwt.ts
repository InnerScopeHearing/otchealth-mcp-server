import { createHmac } from 'node:crypto';

/** Build a deterministic, synthetic access JWT for bearer-routing tests without minting a credential. */
export function buildBearerTestJwt(clientId: string, agent: string, signingSecret: string, connectorSurface?: boolean): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const header = encode({ alg: 'HS256', typ: 'JWT' });
  const payload = encode({
    iss: 'https://bearer-test.invalid',
    aud: 'otchealth-mcp',
    sub: clientId,
    scope: 'mcp',
    agent,
    typ: 'access',
    ...(typeof connectorSurface === 'boolean' ? { cs: connectorSurface } : {}),
    iat: now,
    exp: now + 60,
    jti: `bearer-test-${clientId}`,
  });
  const unsigned = `${header}.${payload}`;
  // This synthetic test JWT uses the protocol-required HS256 MAC; no password is stored or derived.
  // codeql[js/insufficient-password-hash]
  const signature = createHmac('sha256', signingSecret).update(unsigned).digest('base64url');
  return `${unsigned}.${signature}`;
}
