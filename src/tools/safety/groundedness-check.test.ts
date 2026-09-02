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
  assert.ok(summary.includes(CONTENT_SAFETY_PROVIDER_NONE), `summary must carry the honest provider label verbatim: ${summary}`);
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

// ---------------------------------------------------------------------------------------------
// 2026-08-29: Amazon Bedrock Guardrails restores a REAL provider (see ../../safety/
// bedrock-guardrails.ts). Its fail-loud contract adds a THIRD state -- configured:true, ran:false,
// error:<detail> -- for when a configured provider was called but the call itself failed. These
// tests pin that summarizeGroundednessResult treats an error exactly like "not a verdict": never
// rendered as fully grounded, never as ungrounded DETECTED, distinct wording from NOT RUN.
// ---------------------------------------------------------------------------------------------

test('summarizeGroundednessResult: configured:true + error set is reported as an explicit ERROR, never as fully grounded', () => {
  const summary = summarizeGroundednessResult({
    configured: true,
    ran: false,
    ungroundedDetected: false,
    ungroundedPercentage: 0,
    provider: 'bedrock',
    error: 'Bedrock ApplyGuardrail failed: HTTP 403',
    raw: undefined,
  });
  assert.match(summary, /ERROR/);
  assert.doesNotMatch(summary, /fully grounded/i);
  assert.doesNotMatch(summary, /NOT RUN/);
  assert.ok(summary.includes('bedrock'), `summary must carry the provider label: ${summary}`);
  assert.ok(summary.includes('HTTP 403'), `summary must carry the error detail: ${summary}`);
});

test('summarizeGroundednessResult: configured:true + error set stays ERROR even if ungroundedDetected were somehow true (a failed call is never a verdict)', () => {
  const summary = summarizeGroundednessResult({
    configured: true,
    ran: false,
    ungroundedDetected: true,
    ungroundedPercentage: 0.9,
    provider: 'bedrock',
    error: 'network error',
    raw: undefined,
  });
  assert.match(summary, /ERROR/);
  assert.doesNotMatch(summary, /DETECTED/);
});

test('summarizeGroundednessResult: a real Bedrock fully-grounded verdict (ran:true, no error) reports the percentage, same wording as the legacy provider', () => {
  const summary = summarizeGroundednessResult({
    configured: true,
    ran: true,
    ungroundedDetected: false,
    ungroundedPercentage: 0.03,
    provider: 'bedrock',
    raw: { action: 'NONE', assessments: [{}] },
  });
  assert.equal(summary, 'Groundedness: fully grounded (3.0% ungrounded)');
});
