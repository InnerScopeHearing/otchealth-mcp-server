import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

// env.ts validates required gateway config at import time; set synthetic values BEFORE the
// dynamic import (static imports are hoisted above any assignment).
for (const [k, v] of Object.entries({
  CIO_SITE_ID: 'synthetic', CIO_TRACK_KEY: 'synthetic', CIO_APP_API_BEARER: 'synthetic',
  PERPLEXITY_CONNECTOR_TOKEN: 'p'.repeat(32), ADMIN_REVOKE_TOKEN: 'a'.repeat(32), N8N_WEBHOOK_SECRET: 'n'.repeat(32),
})) process.env[k] ??= v;
const { elevenTextToSpeech } = await import('./full-client.js');
import { ELEVEN_DEFAULT_MODEL, elevenModelCharLimit } from './elevenlabs-models.js';

// Mocked fetch only: these tests make ZERO real ElevenLabs calls.
const realFetch = globalThis.fetch;
const realKey = process.env.ELEVENLABS_API_KEY;
let calls: Array<{ url: string; body: any }> = [];

beforeEach(() => {
  calls = [];
  process.env.ELEVENLABS_API_KEY = 'test-key-not-real';
  globalThis.fetch = (async (url: any, init: any) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    return new Response(Buffer.from('FAKEMP3'), { status: 200, headers: { 'content-type': 'audio/mpeg' } });
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  if (realKey === undefined) delete process.env.ELEVENLABS_API_KEY; else process.env.ELEVENLABS_API_KEY = realKey;
});

test('default model is eleven_v4 when model_id is omitted', async () => {
  assert.equal(ELEVEN_DEFAULT_MODEL, 'eleven_v4');
  const r = await elevenTextToSpeech({ voice_id: 'v1', text: 'hello' });
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/text-to-speech\/v1$/);
  assert.equal(calls[0].body.model_id, 'eleven_v4');
  assert.equal(Buffer.from(r.audio_base64, 'base64').toString(), 'FAKEMP3');
});

test('an explicit model_id passes through unchanged', async () => {
  await elevenTextToSpeech({ voice_id: 'v1', text: 'hello', model_id: 'eleven_v4_turbo' });
  assert.equal(calls[0].body.model_id, 'eleven_v4_turbo');
});

test('text over the model limit is rejected locally with no upstream call', async () => {
  await assert.rejects(
    () => elevenTextToSpeech({ voice_id: 'v1', text: 'x'.repeat(10_001) }),
    /eleven_v4 accepts at most 10000 characters/,
  );
  await assert.rejects(
    () => elevenTextToSpeech({ voice_id: 'v1', text: 'x'.repeat(5_001), model_id: 'eleven_v3' }),
    /eleven_v3 accepts at most 5000/,
  );
  assert.equal(calls.length, 0);
});

test('text exactly at the limit is sent, and larger-limit models accept more', async () => {
  await elevenTextToSpeech({ voice_id: 'v1', text: 'x'.repeat(10_000) });
  await elevenTextToSpeech({ voice_id: 'v1', text: 'x'.repeat(20_000), model_id: 'eleven_flash_v2_5' });
  assert.equal(calls.length, 2);
  assert.equal(elevenModelCharLimit('some_future_model'), 40_000);
});
