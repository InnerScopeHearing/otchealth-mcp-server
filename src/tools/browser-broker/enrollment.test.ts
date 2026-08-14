import test from 'node:test';
import assert from 'node:assert/strict';
import { browserEnrollmentSnapshot, enrollmentAllows, resolveBrowserEnrollment, validateEnrollmentTargets } from './enrollment.js';

test('Wefunder Campaign Director is the initial enrolled browser broker agent', () => {
  const enrollment = resolveBrowserEnrollment('wefunder-campaign-director');
  assert.ok(enrollment);
  assert.equal(enrollmentAllows(enrollment, 'public_read'), true);
  assert.equal(enrollmentAllows(enrollment, 'authenticated_read'), false);
  assert.deepEqual(browserEnrollmentSnapshot(enrollment), {
    caller_agent: 'wefunder-campaign-director',
    profile: 'wefunder_campaign_director',
    capabilities: ['public_read'],
  });
});

test('unknown agents and unenrolled targets fail closed', () => {
  assert.equal(resolveBrowserEnrollment('unknown-agent'), null);
  const enrollment = resolveBrowserEnrollment('wefunder-campaign-director');
  assert.ok(enrollment);
  assert.equal(validateEnrollmentTargets(enrollment, ['https://wefunder.com/otchealth.inc']).ok, true);
  assert.equal(validateEnrollmentTargets(enrollment, ['https://evil.example']).ok, false);
  assert.equal(validateEnrollmentTargets(enrollment, ['https://wefunder.com:443']).ok, false);
});
