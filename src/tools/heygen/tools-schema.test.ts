import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z, type ZodRawShape } from 'zod';
import {
  HEYGEN_AVATAR_GROUPS_LIST_INPUT,
  HEYGEN_AVATAR_GROUP_GET_INPUT,
  HEYGEN_AVATAR_LOOKS_LIST_INPUT,
  HEYGEN_AVATAR_LOOK_GET_INPUT,
  HEYGEN_PROMPT_AVATAR_CREATE_INPUT,
  HEYGEN_VOICES_LIST_INPUT,
  HEYGEN_VOICE_DESIGN_INPUT,
} from './tools.js';

function parse(shape: ZodRawShape, value: unknown): unknown {
  return z.object(shape).strict().parse(value);
}

test('official avatar/voice discovery schemas enforce exact enums, ranges, tokens, and URL-safe ids', () => {
  assert.deepEqual(parse(HEYGEN_AVATAR_GROUPS_LIST_INPUT, { ownership: 'private', limit: 50, token: 'next' }), {
    ownership: 'private', limit: 50, token: 'next',
  });
  assert.throws(() => parse(HEYGEN_AVATAR_GROUPS_LIST_INPUT, { ownership: 'owned' }));
  assert.throws(() => parse(HEYGEN_AVATAR_GROUPS_LIST_INPUT, { limit: 51 }));
  assert.deepEqual(parse(HEYGEN_AVATAR_GROUP_GET_INPUT, { group_id: 'group_1-safe' }), { group_id: 'group_1-safe' });
  assert.throws(() => parse(HEYGEN_AVATAR_GROUP_GET_INPUT, { group_id: '../escape' }));

  assert.deepEqual(parse(HEYGEN_AVATAR_LOOKS_LIST_INPUT, {
    group_id: 'group_1', avatar_type: 'digital_twin', ownership: 'public', limit: 1, token: 'next',
  }), {
    group_id: 'group_1', avatar_type: 'digital_twin', ownership: 'public', limit: 1, token: 'next',
  });
  assert.throws(() => parse(HEYGEN_AVATAR_LOOKS_LIST_INPUT, { group_id: 'look/id' }));
  assert.throws(() => parse(HEYGEN_AVATAR_LOOKS_LIST_INPUT, { avatar_type: 'prompt' }));
  assert.deepEqual(parse(HEYGEN_AVATAR_LOOK_GET_INPUT, { look_id: 'look-1' }), { look_id: 'look-1' });
  assert.throws(() => parse(HEYGEN_AVATAR_LOOK_GET_INPUT, { look_id: '..' }));

  assert.deepEqual(parse(HEYGEN_VOICES_LIST_INPUT, {
    type: 'private', engine: 'starfish', language: 'English', gender: 'female', limit: 100, token: 'next',
  }), {
    type: 'private', engine: 'starfish', language: 'English', gender: 'female', limit: 100, token: 'next',
  });
  assert.deepEqual(parse(HEYGEN_VOICES_LIST_INPUT, {}), {}, 'public remains the upstream default');
  assert.throws(() => parse(HEYGEN_VOICES_LIST_INPUT, { limit: 101 }));
  assert.throws(() => parse(HEYGEN_VOICES_LIST_INPUT, { token: 'x'.repeat(4097) }));
  assert.throws(() => parse(HEYGEN_VOICES_LIST_INPUT, { engine: '../starfish' }));
  assert.throws(() => parse(HEYGEN_VOICES_LIST_INPUT, { language: '  ' }));
  assert.throws(() => parse(HEYGEN_VOICES_LIST_INPUT, { gender: 'other' }));
});

test('voice design schema is exact and accepts only semantic-search fields', () => {
  assert.deepEqual(parse(HEYGEN_VOICE_DESIGN_INPUT, {
    prompt: 'warm voice', gender: 'female', locale: 'en-US', seed: 0,
  }), { prompt: 'warm voice', gender: 'female', locale: 'en-US', seed: 0 });
  assert.throws(() => parse(HEYGEN_VOICE_DESIGN_INPUT, { prompt: 'voice', gender: 'other' }));
  assert.throws(() => parse(HEYGEN_VOICE_DESIGN_INPUT, { prompt: 'voice', locale: 'English_US' }));
  assert.throws(() => parse(HEYGEN_VOICE_DESIGN_INPUT, { prompt: 'voice', seed: -1 }));
  assert.throws(() => parse(HEYGEN_VOICE_DESIGN_INPUT, { prompt: '  ' }));
  assert.throws(() => parse(HEYGEN_VOICE_DESIGN_INPUT, { prompt: 'v'.repeat(1001) }));
  assert.throws(() => parse(HEYGEN_VOICE_DESIGN_INPUT, { prompt: 'voice', clone: true }));
});

test('prompt-avatar schema requires confirmation and excludes every other avatar creation mode', () => {
  const valid = {
    name: 'Presenter',
    prompt: 'Professional presenter',
    avatar_group_id: 'group-1',
    confirm_credit_use: true,
    confirmed_premium_credits_before: 7,
  } as const;
  assert.deepEqual(parse(HEYGEN_PROMPT_AVATAR_CREATE_INPUT, valid), valid);
  assert.deepEqual(
    parse(HEYGEN_PROMPT_AVATAR_CREATE_INPUT, { name: 'Preview', prompt: 'Dry-run prompt' }),
    { name: 'Preview', prompt: 'Dry-run prompt' },
    'dry-run planning may omit the real-execution confirmation fields',
  );
  for (const invalid of [
    { ...valid, confirm_credit_use: 'yes' },
    { ...valid, confirmed_premium_credits_before: 1.5 },
    { ...valid, name: '' },
    { ...valid, name: '  ' },
    { ...valid, name: 'n'.repeat(101) },
    { ...valid, prompt: '' },
    { ...valid, prompt: '  ' },
    { ...valid, prompt: 'p'.repeat(1001) },
    { ...valid, avatar_group_id: '../escape' },
    { ...valid, reference_images: [] },
    { ...valid, avatar_id: 'look-1' },
    { ...valid, type: 'photo' },
    { ...valid, file: { type: 'url', url: 'https://example.test/photo.png' } },
  ]) {
    assert.throws(() => parse(HEYGEN_PROMPT_AVATAR_CREATE_INPUT, invalid));
  }
});
