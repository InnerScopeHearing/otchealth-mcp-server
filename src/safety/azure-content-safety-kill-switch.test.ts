import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  shieldPrompt,
  detectGroundedness,
  CONTENT_SAFETY_RETIRED,
  CONTENT_SAFETY_PROVIDER_NONE,
} from './content-safety.js';

/**
 * SOURCE-SCAN REGRESSION -- proves that adding a real provider (Amazon Bedrock Guardrails, see
 * ./bedrock-guardrails.ts) did NOT touch, weaken, or route around content-safety.ts's Azure
 * kill-switch from PR #260 (FND-20260821-e303). That file stays untouched by design: Azure AI
 * Content Safety is PERMANENTLY retired, and this test fails loudly if a future edit ever
 * reintroduces a live Azure call path there, independent of whatever bedrock-guardrails.ts does.
 *
 * This is deliberately STRUCTURAL (reads the actual source, like the sibling azure-dependency-
 * guard.test.ts / azure-workflows-disarmed.test.ts guards in this directory tree) rather than only
 * behavioural: content-safety.test.ts already behaviourally pins shieldPrompt()/
 * detectGroundedness()'s NOT-RUN outputs, but a behavioural test alone would not catch someone
 * flipping the literal kill-switch constant while leaving every OTHER observable behaviour
 * unchanged by coincidence (e.g. by also deleting the endpoint/key env vars in the same commit).
 */

const CONTENT_SAFETY_SRC = readFileSync(
  fileURLToPath(new URL('./content-safety.ts', import.meta.url)),
  'utf8',
);

test('KILL-SWITCH: CONTENT_SAFETY_RETIRED is still declared true, verbatim, in source', () => {
  assert.match(
    CONTENT_SAFETY_SRC,
    /export const CONTENT_SAFETY_RETIRED: boolean = true;/,
    'the Azure kill-switch constant must remain declared exactly as PR #260 shipped it',
  );
});

test('KILL-SWITCH: isConfigured() still gates on !CONTENT_SAFETY_RETIRED, so the constant is not merely declared but unused', () => {
  assert.match(
    CONTENT_SAFETY_SRC,
    /function isConfigured\(\): boolean \{\s*\n\s*return !CONTENT_SAFETY_RETIRED/,
    'isConfigured() must short-circuit on the retirement flag before ever consulting CONTENT_SAFETY_ENDPOINT/KEY',
  );
});

test('KILL-SWITCH: shieldPrompt()/detectGroundedness() still early-return BEFORE any network call when not configured', () => {
  assert.match(CONTENT_SAFETY_SRC, /if \(!isConfigured\(\)\) \{\s*\n\s*return \{/, 'shieldPrompt() must still early-return');
  // Two separate early-returns are expected (shieldPrompt + detectGroundedness); count them rather
  // than matching once, so a future refactor that collapses one away is caught.
  const earlyReturns = CONTENT_SAFETY_SRC.match(/if \(!isConfigured\(\)\) \{/g) || [];
  assert.equal(earlyReturns.length, 2, 'expected exactly two isConfigured() early-return guards (shieldPrompt + detectGroundedness)');
});

test('KILL-SWITCH: the exported CONTENT_SAFETY_RETIRED value really is true (behavioural pin, not just source text)', () => {
  assert.equal(CONTENT_SAFETY_RETIRED, true);
});

// ---------------------------------------------------------------------------------------------
// DECOUPLING: adding Bedrock as a provider must not make content-safety.ts's own exports depend on
// Bedrock's env vars in any way -- the two providers are selected by the TOOL layer (shield-check.ts
// / groundedness-check.ts), never by content-safety.ts itself, which knows nothing about Bedrock.
// ---------------------------------------------------------------------------------------------

test('DECOUPLING: shieldPrompt() stays configured:false/"none (azure retired)" even when GUARDRAIL_PROVIDER=bedrock is set', async () => {
  const prev = { provider: process.env.GUARDRAIL_PROVIDER, id: process.env.BEDROCK_GUARDRAIL_ID };
  process.env.GUARDRAIL_PROVIDER = 'bedrock';
  process.env.BEDROCK_GUARDRAIL_ID = 'some-real-looking-guardrail-id';
  try {
    const result = await shieldPrompt('anything');
    assert.equal(result.configured, false);
    assert.equal(result.provider, CONTENT_SAFETY_PROVIDER_NONE);
  } finally {
    if (prev.provider !== undefined) process.env.GUARDRAIL_PROVIDER = prev.provider; else delete process.env.GUARDRAIL_PROVIDER;
    if (prev.id !== undefined) process.env.BEDROCK_GUARDRAIL_ID = prev.id; else delete process.env.BEDROCK_GUARDRAIL_ID;
  }
});

test('DECOUPLING: detectGroundedness() stays configured:false/"none (azure retired)" even when GUARDRAIL_PROVIDER=bedrock is set', async () => {
  const prev = { provider: process.env.GUARDRAIL_PROVIDER, id: process.env.BEDROCK_GUARDRAIL_ID };
  process.env.GUARDRAIL_PROVIDER = 'bedrock';
  process.env.BEDROCK_GUARDRAIL_ID = 'some-real-looking-guardrail-id';
  try {
    const result = await detectGroundedness('q', 't', ['s']);
    assert.equal(result.configured, false);
    assert.equal(result.provider, CONTENT_SAFETY_PROVIDER_NONE);
  } finally {
    if (prev.provider !== undefined) process.env.GUARDRAIL_PROVIDER = prev.provider; else delete process.env.GUARDRAIL_PROVIDER;
    if (prev.id !== undefined) process.env.BEDROCK_GUARDRAIL_ID = prev.id; else delete process.env.BEDROCK_GUARDRAIL_ID;
  }
});
