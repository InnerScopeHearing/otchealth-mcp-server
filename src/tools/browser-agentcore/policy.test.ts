import test from 'node:test';
import assert from 'node:assert/strict';
import { ProfileLeaseStore, rejectSensitiveIntent, validatePublicTargets } from './policy.js';

test('allows only exact HTTPS public hosts', () => {
  assert.equal(validatePublicTargets(['https://wefunder.com/otchealth.inc']).ok, true);
  assert.equal(validatePublicTargets(['https://help.wefunder.com/']).ok, true);
  assert.equal(validatePublicTargets(['https://otchealth.app']).ok, true);
  assert.equal(validatePublicTargets(['https://wefunder.com.evil.example']).ok, false);
  assert.equal(validatePublicTargets(['https://evil.example@wefunder.com']).ok, false);
  assert.equal(validatePublicTargets(['http://wefunder.com']).ok, false);
});
test('rejects sensitive intent before provider use', () => {
  assert.ok(rejectSensitiveIntent({ intent: 'log in and publish the campaign' }));
  assert.ok(rejectSensitiveIntent({ intent: 'save session profile' }));
  assert.equal(rejectSensitiveIntent({ intent: 'read public campaign title' }), null);
});
test('profile lease is one-writer', () => {
  const leases = new ProfileLeaseStore();
  assert.equal(leases.acquire('aws', 'wefunder', 'profile'), true);
  assert.equal(leases.acquire('aws', 'wefunder', 'profile'), false);
  leases.release('aws', 'wefunder', 'profile');
  assert.equal(leases.acquire('aws', 'wefunder', 'profile'), true);
});
