import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeGroundednessResult } from './groundedness-check.js';
import { CONTENT_SAFETY_PROVIDER_NONE, type GroundednessResult } from '../../safety/content-safety.js';

// ---------------------------------------------------------------------------------------------
// FND-20260821-e303: the "fake pass" bug. Before this fix, summarizeGroundednessResult's inline
// predecessor read only `ungroundedDetected`/`ungroundedPercentage`, so an UNCONFIGURED/retired
// provider (which always reports ungroundedDetected:false, ungroundedPercentage:0) rendered as
// "Groundedness: fully grounded (0.0% ungrounded)" -- indistinguishable from a real check that
// found nothing wrong. These tests pin the fix: `configured:false` must always render as an
// explicit NOT RUN, never as a fully-grounded/ungrounded verdict.
// ---------------------------------------------------------------------------------------------

function retired(overrides: Partial<GroundednessResult> = {}): GroundednessResult {
  return {
    configured: false,
    ungroundedDetected: false,
    ungroundedPercentage: 0,
    provider: CONTENT_SAFETY_PROVIDER_NONE,
    raw: { skipped: 'retired' },
    ...overrides,
  };
}

test('summarizeGroundednessResult: configured:false is reported as NOT RUN, never as "fully grounded" (the fake-pass regression)', () => {
  const summary = summarizeGroundednessResult(retired());
  assert.match(summary, /NOT RUN/);
  assert.doesNotMatch(summary, /fully grounded/i);
  assert.match(summary, new RegExp(CONTENT_SAFETY_PROVIDER_NONE.replace(/[().]/g, '\\$&')));
});

test('summarizeGroundednessResult: configured:false stays NOT RUN even if ungroundedDetected were somehow true (defensive -- a verdict without a check is never trustworthy)', () => {
  const summary = summarizeGroundednessResult(retired({ ungroundedDetected: true, ungroundedPercentage: 0.8 }));
  assert.match(summary, /NOT RUN/);
  assert.doesNotMatch(summary, /DETECTED/);
});

test('summarizeGroundednessResult: configured:true + ungroundedDetected:false reports a real fully-grounded verdict with the percentage', () => {
  const summary = summarizeGroundednessResult({
    configured: true,
    ungroundedDetected: false,
    ungroundedPercentage: 0.03,
    provider: 'azure',
    raw: {},
  });
  assert.equal(summary, 'Groundedness: fully grounded (3.0% ungrounded)');
});

test('summarizeGroundednessResult: configured:true + ungroundedDetected:true reports a real ungrounded verdict with the percentage', () => {
  const summary = summarizeGroundednessResult({
    configured: true,
    ungroundedDetected: true,
    ungroundedPercentage: 0.62,
    provider: 'azure',
    raw: {},
  });
  assert.equal(summary, 'Groundedness: ungrounded content DETECTED (62.0% ungrounded)');
});
