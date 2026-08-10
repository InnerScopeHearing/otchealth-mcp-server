import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { z, type ZodRawShape } from 'zod';
import {
  HEYGEN_ASSET_UPLOAD_INPUT,
  HEYGEN_AVATAR_LOOK_NAME_UPDATE_INPUT,
  HEYGEN_PROOFREAD_CREATE_INPUT,
  HEYGEN_PROOFREAD_GENERATE_INPUT,
  HEYGEN_SPEECH_PREVIEW_CREATE_INPUT,
  HEYGEN_TRANSLATION_CREATE_INPUT,
  HEYGEN_VIDEO_AGENT_FEEDBACK_SEND_INPUT,
  HEYGEN_VIDEO_AGENT_GENERATION_APPROVE_INPUT,
  HEYGEN_VIDEO_AGENT_SESSION_CREATE_INPUT,
  HEYGEN_VIDEO_AGENT_SESSION_STOP_INPUT,
} from './future-tools.js';

function parse(shape: ZodRawShape, value: unknown): unknown {
  return z.object(shape).strict().parse(value);
}

const SHA = 'a'.repeat(64);
const JWS = 'x'.repeat(64);

test('Video Agent schemas separate planning, feedback, generation approval, and stop', () => {
  const create = {
    project_id: 'project_01', action_id: 'action_001', manifest_sha256: SHA,
    planning_prompt: 'Build a plan only.', avatar_id: 'look_1', voice_id: 'voice_1',
    brand_kit_id: 'brand_1', orientation: 'landscape', asset_ids: ['asset_1'],
    billing_snapshot_sha256: SHA, reserve_total_credits: 100,
  } as const;
  assert.deepEqual(parse(HEYGEN_VIDEO_AGENT_SESSION_CREATE_INPUT, create), create);
  assert.throws(() => parse(HEYGEN_VIDEO_AGENT_SESSION_CREATE_INPUT, { ...create, mode: 'generate' }));
  assert.throws(() => parse(HEYGEN_VIDEO_AGENT_SESSION_CREATE_INPUT, { ...create, callback_url: 'https://example.test' }));
  assert.throws(() => parse(HEYGEN_VIDEO_AGENT_SESSION_CREATE_INPUT, { ...create, files: [{ type: 'url' }] }));

  const feedback = {
    session_id: 'session_1', project_id: 'project_01', action_id: 'action_001',
    expected_session_snapshot_sha256: SHA, intent: 'revise_plan', message: 'Use the approved logo.',
  } as const;
  assert.deepEqual(parse(HEYGEN_VIDEO_AGENT_FEEDBACK_SEND_INPUT, feedback), feedback);
  assert.throws(() => parse(HEYGEN_VIDEO_AGENT_FEEDBACK_SEND_INPUT, { ...feedback, intent: 'approve' }));

  const approve = {
    session_id: 'session_1', project_id: 'project_01', action_id: 'action_001',
    manifest_sha256: SHA, review_snapshot_sha256: SHA, billing_snapshot_sha256: SHA,
    max_approved_credits: 10, reserve_total_credits: 100,
    confirm_credit_use: true, accept_unenforced_cost_cap: true, owner_approval_jws: JWS,
  } as const;
  assert.deepEqual(parse(HEYGEN_VIDEO_AGENT_GENERATION_APPROVE_INPUT, approve), approve);
  assert.throws(() => parse(HEYGEN_VIDEO_AGENT_GENERATION_APPROVE_INPUT, { ...approve, message: 'yes' }));
  assert.throws(() => parse(HEYGEN_VIDEO_AGENT_GENERATION_APPROVE_INPUT, { ...approve, confirm_credit_use: false }));

  const stop = {
    session_id: 'session_1', project_id: 'project_01', action_id: 'action_001',
    expected_session_snapshot_sha256: SHA, reason: 'unexpected_generation',
  } as const;
  assert.deepEqual(parse(HEYGEN_VIDEO_AGENT_SESSION_STOP_INPUT, stop), stop);
});

test('asset, translation, proofread, and speech schemas are fixed and bounded', () => {
  const asset = {
    operation_id: 'asset_op_01', idempotency_key: 'asset-op:01',
    source_artifact_uri: 'azure://account/container/path/logo.png', filename: 'logo.png',
    content_type: 'image/png', size_bytes: 1024, checksum_sha256: SHA,
  } as const;
  assert.deepEqual(parse(HEYGEN_ASSET_UPLOAD_INPUT, asset), asset);
  assert.throws(() => parse(HEYGEN_ASSET_UPLOAD_INPUT, { ...asset, source_artifact_uri: 'https://example.test/logo.png' }));
  assert.throws(() => parse(HEYGEN_ASSET_UPLOAD_INPUT, { ...asset, content_type: 'application/zip' }));
  assert.throws(() => parse(HEYGEN_ASSET_UPLOAD_INPUT, { ...asset, size_bytes: 33_554_433 }));

  const translation = {
    operation_id: 'trans_op_01', idempotency_key: 'trans-op:01', source_asset_id: 'asset_1',
    locked_master_sha256: SHA, title: 'Spanish master', output_languages: ['Spanish (Spain)'],
    mode: 'speed', billing_snapshot_sha256: SHA, max_approved_credits: 10,
    reserve_total_credits: 100, owner_approval_jws: JWS,
  } as const;
  assert.deepEqual(parse(HEYGEN_TRANSLATION_CREATE_INPUT, translation), translation);
  assert.throws(() => parse(HEYGEN_TRANSLATION_CREATE_INPUT, { ...translation, output_languages: [] }));
  assert.throws(() => parse(HEYGEN_TRANSLATION_CREATE_INPUT, { ...translation, mode: 'auto' }));
  assert.throws(() => parse(HEYGEN_TRANSLATION_CREATE_INPUT, { ...translation, video_url: 'https://example.test' }));

  const proofread = {
    operation_id: 'proof_op_01', idempotency_key: 'proof-op:01', source_asset_id: 'asset_1',
    locked_master_sha256: SHA, title: 'Spanish proofread', output_languages: ['Spanish (Spain)'], mode: 'speed',
  } as const;
  assert.deepEqual(parse(HEYGEN_PROOFREAD_CREATE_INPUT, proofread), proofread);
  const generate = {
    operation_id: 'proofgen_01', idempotency_key: 'proofgen:01', proofread_id: 'proof_1',
    approved_proofread_sha256: SHA, billing_snapshot_sha256: SHA,
    max_approved_credits: 10, reserve_total_credits: 100, owner_approval_jws: JWS,
  } as const;
  assert.deepEqual(parse(HEYGEN_PROOFREAD_GENERATE_INPUT, generate), generate);

  const speech = {
    operation_id: 'speech_001', voice_id: 'voice_1', text: 'Hello.', input_type: 'text', speed: 1,
    language: 'en', locale: 'en-US', billing_snapshot_sha256: SHA,
    max_approved_credits: 1, owner_approval_jws: JWS,
  } as const;
  assert.deepEqual(parse(HEYGEN_SPEECH_PREVIEW_CREATE_INPUT, speech), speech);
  assert.throws(() => parse(HEYGEN_SPEECH_PREVIEW_CREATE_INPUT, { ...speech, clone: true }));
  assert.deepEqual(parse(HEYGEN_AVATAR_LOOK_NAME_UPDATE_INPUT, {
    look_id: 'look_1', name: 'OTCH Family Story - Kimberly',
  }), { look_id: 'look_1', name: 'OTCH Family Story - Kimberly' });
  assert.throws(() => parse(HEYGEN_AVATAR_LOOK_NAME_UPDATE_INPUT, {
    look_id: '../escape', name: 'Name', tags: ['forbidden'],
  }));
});

test('preflight-only registrations are explicitly non-implemented and never expose generic provider input', () => {
  const source = readFileSync(new URL('./future-tools.ts', import.meta.url), 'utf8');
  for (const flag of [
    'ENABLE_HEYGEN_VIDEO_AGENT_CHAT_WRITES',
    'ENABLE_HEYGEN_VIDEO_AGENT_GENERATION',
    'ENABLE_HEYGEN_ASSET_WRITES',
    'ENABLE_HEYGEN_TRANSLATION_WRITES',
    'ENABLE_HEYGEN_TTS_WRITES',
    'ENABLE_HEYGEN_METADATA_WRITES',
  ]) assert.match(source, new RegExp(flag));
  assert.doesNotMatch(source, /api_key|x-api-key|raw_headers|arbitrary_path/);
  assert.match(source, /implemented: false/);
  assert.equal((source.match(/name: 'heygen_[a-z0-9_]+_preflight'/g) ?? []).length, 9);
  assert.match(source, /mode: 'chat'/);
  assert.match(source, /incognito_mode: true/);
  assert.match(source, /body: \(\) => \(\{\}\)/);
  assert.match(source, /owner_approval_jws/);
  assert.match(source, /for \(const key of \['planning_prompt', 'message', 'text', 'name', 'title', 'filename'\]\)/);
  assert.doesNotMatch(source, /projected\[.*owner_approval_jws/);
});
