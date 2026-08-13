import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, type JsonWebKey } from 'node:crypto';
import { heyGenApprovalCompatibilityFingerprints, heyGenPublicJwkFingerprint } from './approval-fingerprint.js';

test('approval compatibility fingerprints are deterministic and never return secret material', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const publicJwk = publicKey.export({ format: 'jwk' }) as JsonWebKey;
  const privateJwk = privateKey.export({ format: 'jwk' }) as JsonWebKey;
  publicJwk.kid = 'approval-key-1';
  privateJwk.kid = 'approval-key-1';
  const secret = 'secret-with-at-least-thirty-two-random-bytes';
  const fingerprints = heyGenApprovalCompatibilityFingerprints({
    publicJwk: JSON.stringify(publicJwk), contextSecret: secret, handleSecret: secret, callbackSecret: secret,
  });
  assert.match(fingerprints.public_jwk_sha256!, /^[a-f0-9]{64}$/);
  assert.equal(fingerprints.context_secret_sha256, fingerprints.handle_secret_sha256);
  assert.ok(!JSON.stringify(fingerprints).includes(secret));
  assert.equal(heyGenPublicJwkFingerprint(JSON.stringify(privateJwk)), undefined);
});
