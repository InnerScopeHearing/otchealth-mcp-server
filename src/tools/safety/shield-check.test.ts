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

// ---------------------------------------------------------------------------------------------
// 2026-08-29: Amazon Bedrock Guardrails restores a REAL provider (see ../../safety/
// bedrock-guardrails.ts). Its fail-loud contract adds a THIRD state -- configured:true, ran:false,
// error:<detail> -- for when a configured provider was called but the call itself failed. These
// tests pin that summarizeShieldResult treats an error exactly like "not a verdict": never
// rendered as clean, never as an attack DETECTED, distinct wording from NOT RUN.
// ---------------------------------------------------------------------------------------------

test('summarizeShieldResult: configured:true + error set is reported as an explicit ERROR, never as clean', () => {
  const summary = summarizeShieldResult({
    configured: true,
    ran: false,
    attackDetected: false,
    userPromptAttack: false,
    documentsAttack: false,
    provider: 'bedrock',
    error: 'Bedrock ApplyGuardrail failed: HTTP 403',
    raw: undefined,
  });
  assert.match(summary, /ERROR/);
  assert.doesNotMatch(summary, /Prompt Shields: clean/);
  assert.doesNotMatch(summary, /NOT RUN/);
  assert.ok(summary.includes('bedrock'), `summary must carry the provider label: ${summary}`);
  assert.ok(summary.includes('HTTP 403'), `summary must carry the error detail: ${summary}`);
});

test('summarizeShieldResult: configured:true + error set stays ERROR even if attackDetected were somehow true (a failed call is never a verdict)', () => {
  const summary = summarizeShieldResult({
    configured: true,
    ran: false,
    attackDetected: true,
    userPromptAttack: true,
    documentsAttack: false,
    provider: 'bedrock',
    error: 'network error',
    raw: undefined,
  });
  assert.match(summary, /ERROR/);
  assert.doesNotMatch(summary, /DETECTED/);
});

test('summarizeShieldResult: a real Bedrock clean verdict (ran:true, no error) reports clean, same wording as the legacy provider', () => {
  const summary = summarizeShieldResult({
    configured: true,
    ran: true,
    attackDetected: false,
    userPromptAttack: false,
    documentsAttack: false,
    provider: 'bedrock',
    raw: { action: 'NONE', assessments: [{}] },
  });
  assert.equal(summary, 'Prompt Shields: clean');
});
