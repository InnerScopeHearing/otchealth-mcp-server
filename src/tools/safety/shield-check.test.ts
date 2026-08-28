import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeShieldResult } from './shield-check.js';
import { CONTENT_SAFETY_PROVIDER_NONE, type ShieldPromptResult } from '../../safety/content-safety.js';

// ---------------------------------------------------------------------------------------------
// FND-20260821-e303: the "fake pass" bug. Before this fix, summarizeShieldResult's inline
// predecessor read only `attackDetected`, so an UNCONFIGURED/retired provider (which always
// reports attackDetected:false) rendered as "Prompt Shields: clean" -- indistinguishable from a
// real scan that found nothing. These tests pin the fix: `configured:false` must always render as
// an explicit NOT RUN, never as a clean/attack verdict.
// ---------------------------------------------------------------------------------------------

function retired(overrides: Partial<ShieldPromptResult> = {}): ShieldPromptResult {
  return {
    configured: false,
    attackDetected: false,
    userPromptAttack: false,
    documentsAttack: false,
    provider: CONTENT_SAFETY_PROVIDER_NONE,
    raw: { skipped: 'retired' },
    ...overrides,
  };
}

test('summarizeShieldResult: configured:false is reported as NOT RUN, never as "clean" (the fake-pass regression)', () => {
  const summary = summarizeShieldResult(retired());
  assert.match(summary, /NOT RUN/);
  assert.doesNotMatch(summary, /clean/i);
  assert.ok(summary.includes(CONTENT_SAFETY_PROVIDER_NONE), `summary must carry the honest provider label verbatim: ${summary}`);
});

test('summarizeShieldResult: configured:false stays NOT RUN even if attackDetected were somehow true (defensive -- a verdict without a scan is never trustworthy)', () => {
  const summary = summarizeShieldResult(retired({ attackDetected: true }));
  assert.match(summary, /NOT RUN/);
  assert.doesNotMatch(summary, /DETECTED/);
});

test('summarizeShieldResult: configured:true + attackDetected:false reports a real clean verdict', () => {
  const summary = summarizeShieldResult({
    configured: true,
    attackDetected: false,
    userPromptAttack: false,
    documentsAttack: false,
    provider: 'azure',
    raw: {},
  });
  assert.equal(summary, 'Prompt Shields: clean');
});

test('summarizeShieldResult: configured:true + attackDetected:true reports a real attack verdict', () => {
  const summary = summarizeShieldResult({
    configured: true,
    attackDetected: true,
    userPromptAttack: true,
    documentsAttack: false,
    provider: 'azure',
    raw: {},
  });
  assert.equal(summary, 'Prompt Shields: attack DETECTED');
});
