import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, type JsonWebKey } from 'node:crypto';
import { heyGenPublicJwkFingerprint } from './approval-fingerprint.js';

test('public approval-key fingerprint is deterministic and rejects private JWKs', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const publicJwk = publicKey.export({ format: 'jwk' }) as JsonWebKey;
  const privateJwk = privateKey.export({ format: 'jwk' }) as JsonWebKey;
  publicJwk.kid = 'approval-key-1';
  privateJwk.kid = 'approval-key-1';
  const fingerprint = heyGenPublicJwkFingerprint(JSON.stringify(publicJwk));
  assert.match(fingerprint!, /^[a-f0-9]{64}$/);
  assert.equal(fingerprint, heyGenPublicJwkFingerprint(JSON.stringify(publicJwk)));
  assert.equal(heyGenPublicJwkFingerprint(JSON.stringify(privateJwk)), undefined);
});
