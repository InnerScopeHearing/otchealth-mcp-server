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
import {
  HEYGEN_REFERENCE_LOOK_CREATE_INPUT,
  HEYGEN_REFERENCE_LOOK_OPERATION_GET_INPUT,
} from './look-tools.js';
import {
  HEYGEN_ASSET_GET_INPUT,
  HEYGEN_ASSET_STATUSES_INPUT,
  HEYGEN_AVATAR_VIDEO_CREATE_INPUT,
  HEYGEN_EXISTING_VIDEO_INGEST_QA_INPUT,
  HEYGEN_AVATAR_VIDEO_OPERATION_GET_INPUT,
  HEYGEN_BRAND_GLOSSARIES_LIST_INPUT,
  HEYGEN_BRAND_GLOSSARY_GET_INPUT,
  HEYGEN_BRAND_KITS_LIST_INPUT,
  HEYGEN_PROOFREAD_GET_INPUT,
  HEYGEN_TRANSLATION_GET_INPUT,
  HEYGEN_TRANSLATION_STATUSES_INPUT,
  HEYGEN_TRANSLATIONS_LIST_INPUT,
  HEYGEN_VIDEO_AGENT_RESOURCE_GET_INPUT,
  HEYGEN_VIDEO_AGENT_SESSION_GET_INPUT,
  HEYGEN_VIDEO_AGENT_SESSION_VIDEOS_LIST_INPUT,
  HEYGEN_VIDEO_AGENT_SESSIONS_LIST_INPUT,
  HEYGEN_VIDEO_STATUSES_INPUT,
  HEYGEN_VIDEO_WAIT_INGEST_QA_INPUT,
  HEYGEN_VOICE_GET_INPUT,
} from './production-tools.js';

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

test('reference-conditioned Look schema is exact, bounded, and owner-grant ready', () => {
  const valid = {
    operation_id: 'look_op_01',
    idempotency_key: 'look-op:01',
    source_avatar_id: 'look_source',
    destination_group_id: 'group_1',
    name: 'OTCH Founder Look',
    prompt: 'Photorealistic horizontal documentary portrait.',
    reference_asset_ids: ['asset_1', 'asset_2', 'asset_3'],
    confirmed_billing_snapshot_sha256: 'a'.repeat(64),
    confirmed_billing_state_sha256: 'b'.repeat(64),
    confirmed_billing_observed_at: '2026-08-10T00:00:00.000Z',
    confirmed_premium_credits_before: 591,
    reserve_premium_credits: 100,
    owner_approval_jws: 'x'.repeat(64),
    confirm_credit_use: true,
  } as const;
  assert.deepEqual(parse(HEYGEN_REFERENCE_LOOK_CREATE_INPUT, valid), valid);
  for (const invalid of [
    { ...valid, operation_id: 'short' },
    { ...valid, idempotency_key: 'bad key' },
    { ...valid, source_avatar_id: '../escape' },
    { ...valid, prompt: 'x'.repeat(1001) },
    { ...valid, reference_asset_ids: ['a', 'b', 'c', 'd'] },
    { ...valid, confirmed_billing_snapshot_sha256: 'A'.repeat(64) },
    { ...valid, confirmed_billing_state_sha256: 'A'.repeat(64) },
    { ...valid, confirmed_billing_observed_at: 'not-a-date' },
    { ...valid, api_key: 'forbidden' },
    { ...valid, callback_url: 'https://example.test' },
  ]) assert.throws(() => parse(HEYGEN_REFERENCE_LOOK_CREATE_INPUT, invalid));
});

test('Phase 0 read schemas are strict, bounded, and path-safe', () => {
  assert.deepEqual(parse(HEYGEN_VIDEO_STATUSES_INPUT, { video_ids: ['v_1'], batch_ids: ['b-1'] }), {
    video_ids: ['v_1'], batch_ids: ['b-1'],
  });
  assert.throws(() => parse(HEYGEN_VIDEO_STATUSES_INPUT, { video_ids: ['../escape'] }));
  assert.throws(() => parse(HEYGEN_VIDEO_STATUSES_INPUT, { video_ids: Array(101).fill('v') }));
  for (const shape of [
    HEYGEN_VIDEO_AGENT_SESSIONS_LIST_INPUT,
    HEYGEN_BRAND_KITS_LIST_INPUT,
    HEYGEN_BRAND_GLOSSARIES_LIST_INPUT,
    HEYGEN_TRANSLATIONS_LIST_INPUT,
  ]) {
    assert.deepEqual(parse(shape, { limit: 100, token: 'next' }), { limit: 100, token: 'next' });
    assert.throws(() => parse(shape, { limit: 101 }));
    assert.throws(() => parse(shape, { token: 'x'.repeat(4097) }));
  }
  for (const [shape, key] of [
    [HEYGEN_VIDEO_AGENT_SESSION_GET_INPUT, 'session_id'],
    [HEYGEN_VIDEO_AGENT_SESSION_VIDEOS_LIST_INPUT, 'session_id'],
    [HEYGEN_ASSET_GET_INPUT, 'asset_id'],
    [HEYGEN_BRAND_GLOSSARY_GET_INPUT, 'brand_glossary_id'],
    [HEYGEN_VOICE_GET_INPUT, 'voice_id'],
    [HEYGEN_TRANSLATION_GET_INPUT, 'video_translation_id'],
    [HEYGEN_PROOFREAD_GET_INPUT, 'proofread_id'],
    [HEYGEN_AVATAR_VIDEO_OPERATION_GET_INPUT, 'operation_id'],
    [HEYGEN_REFERENCE_LOOK_OPERATION_GET_INPUT, 'operation_id'],
  ] as const) {
    const value = key === 'operation_id' ? 'operation_01' : 'safe_id-1';
    assert.deepEqual(parse(shape, { [key]: value }), { [key]: value });
    assert.throws(() => parse(shape, { [key]: '../escape' }));
  }
  assert.deepEqual(parse(HEYGEN_VIDEO_AGENT_RESOURCE_GET_INPUT, {
    session_id: 'session_1', resource_id: 'resource_1',
  }), { session_id: 'session_1', resource_id: 'resource_1' });
  assert.throws(() => parse(HEYGEN_VIDEO_AGENT_RESOURCE_GET_INPUT, {
    session_id: 'session_1', resource_id: '../escape',
  }));
  assert.deepEqual(parse(HEYGEN_ASSET_STATUSES_INPUT, { asset_ids: ['asset_1'] }), {
    asset_ids: ['asset_1'],
  });
  assert.deepEqual(parse(HEYGEN_TRANSLATION_STATUSES_INPUT, { video_translation_ids: ['t1'] }), {
    video_translation_ids: ['t1'],
  });
});

test('direct Avatar Video schema accepts only the bounded deterministic surface', () => {
  const valid = {
    operation_id: 'video_op_01',
    idempotency_key: 'video-op:01',
    manifest_sha256: 'a'.repeat(64),
    title: 'Executive update',
    avatar_id: 'look_1',
    voice_id: 'voice_1',
    script: 'Exact approved script.',
    engine: 'avatar_v',
    reference_look_id: 'look_ref',
    resolution: '1080p',
    aspect_ratio: '16:9',
    fit: 'contain',
    motion_prompt: 'Hands still, calm and confident.',
    background: { type: 'color', value: '#0A1628' },
    caption: { file_format: 'srt', style: 'default' },
    voice_settings: { speed: 1, pitch: 0, volume: 1, locale: 'en-US' },
    brand_glossary_id: 'glossary_1',
    confirm_credit_use: true,
    confirmed_premium_credits_before: 981,
    confirmed_billing_snapshot_sha256: 'b'.repeat(64),
    confirmed_billing_state_sha256: 'c'.repeat(64),
    confirmed_billing_observed_at: '2026-08-10T00:00:00.000Z',
    owner_approval_jws: 'x'.repeat(64),
    max_approved_credits: 20,
    reserve_premium_credits: 300,
  } as const;
  assert.deepEqual(parse(HEYGEN_AVATAR_VIDEO_CREATE_INPUT, valid), valid);
  assert.deepEqual(parse(HEYGEN_AVATAR_VIDEO_CREATE_INPUT, {
    ...valid,
    production_profile: 'family_story_final',
    family_story_founder: 'matthew',
  }), {
    ...valid,
    production_profile: 'family_story_final',
    family_story_founder: 'matthew',
  });
  for (const invalid of [
    { ...valid, operation_id: 'short' },
    { ...valid, idempotency_key: 'bad key' },
    { ...valid, manifest_sha256: 'A'.repeat(64) },
    { ...valid, confirmed_billing_snapshot_sha256: 'A'.repeat(64) },
    { ...valid, confirmed_billing_state_sha256: 'A'.repeat(64) },
    { ...valid, confirmed_billing_observed_at: 'not-a-date' },
    { ...valid, owner_approval_jws: 'short' },
    { ...valid, resolution: '4k' },
    { ...valid, engine: 'avatar_vi' },
    { ...valid, production_profile: 'family_story_best' },
    { ...valid, family_story_founder: 'other' },
    { ...valid, voice_settings: { speed: 2 } },
    { ...valid, background: { type: 'image', url: 'https://example.test/image.png' } },
    { ...valid, callback_url: 'https://example.test/callback' },
    { ...valid, audio_url: 'https://example.test/audio.mp3' },
    { ...valid, output_format: 'webm' },
    { ...valid, watermark: {} },
  ]) {
    assert.throws(() => parse(HEYGEN_AVATAR_VIDEO_CREATE_INPUT, invalid));
  }
  assert.deepEqual(parse(HEYGEN_EXISTING_VIDEO_INGEST_QA_INPUT, {
    ingest_id: 'existing_01', video_id: 'v_1', expected_title_sha256: 'a'.repeat(64),
  }), { ingest_id: 'existing_01', video_id: 'v_1', expected_title_sha256: 'a'.repeat(64) });
  assert.throws(() => parse(HEYGEN_EXISTING_VIDEO_INGEST_QA_INPUT, {
    ingest_id: 'short', video_id: 'v_1', expected_title_sha256: 'A'.repeat(64),
  }));
  assert.deepEqual(parse(HEYGEN_VIDEO_WAIT_INGEST_QA_INPUT, {
    operation_id: 'video_op_01', video_id: 'v_1', max_wait_seconds: 90, max_asset_bytes: 52_428_800,
  }), { operation_id: 'video_op_01', video_id: 'v_1', max_wait_seconds: 90, max_asset_bytes: 52_428_800 });
  assert.throws(() => parse(HEYGEN_VIDEO_WAIT_INGEST_QA_INPUT, {
    operation_id: 'video_op_01', video_id: 'v_1', max_wait_seconds: 91,
  }));
});
