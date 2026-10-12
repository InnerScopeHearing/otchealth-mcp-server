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

test('CTO compatibility enrollment is separate and remains public-read-only', () => {
  const enrollment = resolveBrowserEnrollment('cto');
  assert.ok(enrollment);
  assert.deepEqual(browserEnrollmentSnapshot(enrollment), {
    caller_agent: 'cto',
    profile: 'cto_wefunder_public_read',
    capabilities: ['public_read'],
  });
  assert.equal(enrollmentAllows(enrollment, 'authenticated_read'), false);
  assert.equal(enrollmentAllows(enrollment, 'draft_write'), false);
  assert.equal(enrollmentAllows(enrollment, 'committed_write'), false);
});

test('Developer is enrolled only for public reads on the approved cloud documentation hosts', () => {
  const enrollment = resolveBrowserEnrollment('developer');
  assert.ok(enrollment);
  assert.deepEqual(browserEnrollmentSnapshot(enrollment), {
    caller_agent: 'developer',
    profile: 'developer_cloud_public_read',
    capabilities: ['public_read'],
  });
  assert.deepEqual(enrollment.allowedHosts, [
    'docs.aws.amazon.com',
    'docs.github.com',
    'developers.openai.com',
    'example.com',
  ]);
  assert.equal(enrollmentAllows(enrollment, 'public_read'), true);
  assert.equal(enrollmentAllows(enrollment, 'authenticated_read'), false);
  assert.equal(enrollmentAllows(enrollment, 'draft_write'), false);
  assert.equal(enrollmentAllows(enrollment, 'committed_write'), false);
  for (const host of enrollment.allowedHosts) {
    assert.equal(validateEnrollmentTargets(enrollment, [`https://${host}/`]).ok, true);
  }
  assert.equal(validateEnrollmentTargets(enrollment, ['https://aws.amazon.com/']).ok, false);
  assert.equal(validateEnrollmentTargets(enrollment, ['https://docs.aws.amazon.com:443/']).ok, false);
  assert.equal(validateEnrollmentTargets(enrollment, ['https://user@docs.aws.amazon.com/']).ok, false);
});

test('unknown agents and unenrolled targets fail closed', () => {
  assert.equal(resolveBrowserEnrollment('unknown-agent'), null);
  assert.equal(resolveBrowserEnrollment('customer'), null);
  const enrollment = resolveBrowserEnrollment('wefunder-campaign-director');
  assert.ok(enrollment);
  assert.equal(validateEnrollmentTargets(enrollment, ['https://wefunder.com/otchealth.inc']).ok, true);
  assert.equal(validateEnrollmentTargets(enrollment, ['https://evil.example']).ok, false);
  assert.equal(validateEnrollmentTargets(enrollment, ['https://wefunder.com:443']).ok, false);
});
