import test from 'node:test';
import assert from 'node:assert/strict';
import { ProfileLeaseStore, redactedReceipt, rejectSensitiveIntent, validatePublicTargets } from './policy.js';
import { agentCoreRuntimeConfig, assertAgentCoreConfigured, buildAgentCoreStartRequest, signAgentCoreListBrowsers } from './transport.js';

test('allows only exact HTTPS public hosts', () => {
  assert.equal(validatePublicTargets(['https://wefunder.com/otchealth.inc']).ok, true);
  assert.equal(validatePublicTargets(['https://help.wefunder.com/']).ok, true);
  assert.equal(validatePublicTargets(['https://otchealth.app']).ok, true);
  assert.equal(validatePublicTargets(['https://wefunder.com.evil.example']).ok, false);
  assert.equal(validatePublicTargets(['https://evil.example@wefunder.com']).ok, false);
  assert.equal(validatePublicTargets(['https://wefunder.com:443']).ok, false);
  assert.equal(validatePublicTargets(['http://wefunder.com']).ok, false);
});

test('rejects sensitive intent before provider use', () => {
  assert.ok(rejectSensitiveIntent({ intent: 'log in and publish the campaign' }));
  assert.ok(rejectSensitiveIntent({ intent: 'save session profile' }));
  assert.ok(rejectSensitiveIntent({ intent: 'please send an investor a message' }));
  assert.equal(rejectSensitiveIntent({ intent: 'read public campaign title' }), null);
});

test('profile lease is one-writer', () => {
  const leases = new ProfileLeaseStore();
  assert.equal(leases.acquire('aws', 'wefunder', 'profile'), true);
  assert.equal(leases.acquire('aws', 'wefunder', 'profile'), false);
  leases.release('aws', 'wefunder', 'profile');
  assert.equal(leases.acquire('aws', 'wefunder', 'profile'), true);
});

test('receipt excludes provider session data', () => {
  const receipt = redactedReceipt(new URL('https://wefunder.com/otchealth.inc'), 200, 'Example', 'https://wefunder.com/otchealth.inc');
  assert.deepEqual(Object.keys(receipt).sort(), ['cleanup_success', 'final_host', 'host', 'observed_at', 'status', 'title']);
});

test('runtime remains disabled or unconfigured without secrets', () => {
  const disabled = agentCoreRuntimeConfig({ ENABLE_AGENTCORE_WEFUNDER_PUBLIC_READONLY: 'false' });
  assert.throws(() => assertAgentCoreConfigured(disabled), /disabled/);
  const unconfigured = agentCoreRuntimeConfig({ ENABLE_AGENTCORE_WEFUNDER_PUBLIC_READONLY: 'true' });
  assert.throws(() => assertAgentCoreConfigured(unconfigured), /credentials/);
});

test('AgentCore start request is bounded, idempotent, and has no persistent profile', () => {
  const request = buildAgentCoreStartRequest(300);
  assert.equal(request.name, 'wefunder-public-readonly');
  assert.equal(request.sessionTimeoutSeconds, 300);
  assert.deepEqual(request.viewPort, { width: 1440, height: 900 });
  assert.match(request.clientToken, /^[a-f0-9]{48}$/);
  assert.equal('profileConfiguration' in request, false);
});

test('SigV4 header construction is deterministic and does not expose secret', () => {
  const headers = signAgentCoreListBrowsers({ region: 'us-east-1', accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'test-secret', sessionToken: '' }, new Date('2026-08-13T00:00:00.000Z'));
  assert.match(headers.authorization, /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\//);
  assert.doesNotMatch(JSON.stringify(headers), /test-secret/);
  assert.equal(headers.host, 'bedrock-agentcore.us-east-1.amazonaws.com');
});
