import { test } from 'node:test';
import assert from 'node:assert/strict';

// Own file/process, same env-stub preamble as the sibling foundry tests: importing foundry.ts pulls
// in loadEnv() consumers, and the helper under test is pure.
process.env.CIO_SITE_ID ||= 'test';
process.env.CIO_TRACK_KEY ||= 'test';
process.env.CIO_APP_API_BEARER ||= 'test';
process.env.PERPLEXITY_CONNECTOR_TOKEN ||= 'x'.repeat(32);
process.env.ADMIN_REVOKE_TOKEN ||= 'x'.repeat(32);

const { ensureJsonModeMessages, JSON_MODE_NUDGE } = await import('./foundry.js');
type Msg = { role: 'system' | 'user' | 'assistant'; content: string };

// Regression gate for the 2026-09-03 live failure: llm_azure task=classify + jsonMode=true 400'd on
// every tier with "'messages' must contain the word 'json' in some form, to use 'response_format' of
// type 'json_object'" because the classify prompt never said JSON. The guard lives in chat()'s single
// request builder so the rule can never bite another caller.

test('jsonMode with no json mention appends exactly one trailing system nudge', () => {
  const msgs: Msg[] = [
    { role: 'system', content: 'You are a classifier. Reply with only the label.' },
    { role: 'user', content: 'The deploy completed and the health check returned 200.' },
  ];
  const out = ensureJsonModeMessages(msgs, true);
  assert.equal(out.length, 3);
  assert.deepEqual(out[2], { role: 'system', content: JSON_MODE_NUDGE });
  assert.match(JSON_MODE_NUDGE, /json/i, 'the nudge itself must satisfy the rule it exists for');
  assert.equal(msgs.length, 2, 'the caller array is never mutated');
});

test('jsonMode with an existing json mention (any case, any role) returns the SAME array untouched', () => {
  for (const content of ['Reply with JSON only.', 'respond with ONLY compact json, no prose', 'Return ONLY JSON: {"verdict":"pass"}']) {
    const msgs: Msg[] = [{ role: 'system', content }, { role: 'user', content: 'x' }];
    assert.equal(ensureJsonModeMessages(msgs, true), msgs, `untouched for: ${content}`);
  }
  const userOnly: Msg[] = [{ role: 'system', content: 'be terse' }, { role: 'user', content: 'give me json' }];
  assert.equal(ensureJsonModeMessages(userOnly, true), userOnly);
});

test('jsonMode off (false or undefined) is a strict no-op even when nothing mentions json', () => {
  const msgs: Msg[] = [{ role: 'user', content: 'plain completion' }];
  assert.equal(ensureJsonModeMessages(msgs, false), msgs);
  assert.equal(ensureJsonModeMessages(msgs, undefined), msgs);
});

test('a message with missing/non-string content does not throw and still gets the nudge', () => {
  const weird = [{ role: 'user', content: undefined }] as unknown as Msg[];
  const out = ensureJsonModeMessages(weird, true);
  assert.equal(out.length, 2);
  assert.equal(out[1].content, JSON_MODE_NUDGE);
});
