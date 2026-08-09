import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildHeyGenAvatarVideoPlan,
  canonicalRequestSha256,
  estimateAvatarVideoCredits,
  parseHeyGenAvatarGroup,
  parseHeyGenAvatarLook,
  parseHeyGenCreateVideo,
  parseHeyGenVideoDetail,
  parseHeyGenVoice,
  validateHeyGenAvatarVideoCompatibility,
  type HeyGenAvatarVideoCreateInput,
} from './video-contracts.js';

function validInput(overrides: Partial<HeyGenAvatarVideoCreateInput> = {}): HeyGenAvatarVideoCreateInput {
  return {
    operationId: 'video_op_01',
    idempotencyKey: 'video-op:01',
    manifestSha256: 'a'.repeat(64),
    title: ' Executive update ',
    avatarId: 'look_1',
    voiceId: 'voice_1',
    script: 'Exact approved script.\nSecond line is preserved.',
    engine: 'avatar_v',
    referenceLookId: 'ref_1',
    resolution: '1080p',
    aspectRatio: '16:9',
    fit: 'contain',
    motionPrompt: 'Hands still, calm and confident.',
    background: { type: 'color', value: '#0A1628' },
    caption: { fileFormat: 'srt', style: 'default' },
    voiceSettings: { speed: 1, pitch: 0, volume: 1, locale: 'en-US' },
    brandGlossaryId: 'glossary_1',
    confirmCreditUse: true,
    confirmedPremiumCreditsBefore: 981,
    maxApprovedCredits: 20,
    reservePremiumCredits: 300,
    ...overrides,
  };
}

test('direct video plan emits the exact bounded upstream body and preserves approved script bytes', () => {
  const input = validInput();
  const plan = buildHeyGenAvatarVideoPlan(input);
  assert.equal(plan.body.type, 'avatar');
  assert.equal(plan.body.title, 'Executive update');
  assert.equal(plan.body.script, input.script);
  assert.deepEqual(plan.body.engine, { type: 'avatar_v', reference_look_id: 'ref_1' });
  assert.deepEqual(plan.body.background, { type: 'color', value: '#0a1628' });
  assert.deepEqual(plan.body.caption, { file_format: 'srt', style: 'default' });
  assert.equal(plan.body.output_format, 'mp4');
  assert.equal(plan.body.callback_id, input.operationId);
  assert.equal(Object.hasOwn(plan.body, 'callback_url'), false);
  assert.equal(Object.hasOwn(plan.body, 'audio_url'), false);
  assert.equal(Object.hasOwn(plan.body, 'watermark'), false);
  assert.match(plan.requestSha256, /^[a-f0-9]{64}$/);
  assert.match(plan.scriptSha256, /^[a-f0-9]{64}$/);
  assert.match(plan.idempotencyKeySha256, /^[a-f0-9]{64}$/);
  assert.ok(plan.estimatedCredits > 0 && plan.estimatedCredits <= input.maxApprovedCredits);
});

test('canonical request hash is object-key-order independent but content sensitive', () => {
  const plan = buildHeyGenAvatarVideoPlan(validInput());
  const reordered = {
    ...plan.body,
    voice_settings: plan.body.voice_settings ? {
      locale: plan.body.voice_settings.locale,
      volume: plan.body.voice_settings.volume,
      pitch: plan.body.voice_settings.pitch,
      speed: plan.body.voice_settings.speed,
    } : undefined,
  };
  assert.equal(canonicalRequestSha256(plan.body), canonicalRequestSha256(reordered));
  assert.notEqual(
    canonicalRequestSha256(plan.body),
    canonicalRequestSha256({ ...plan.body, script: `${plan.body.script} changed` }),
  );
});

test('credit estimate is conservative, engine-aware, and custom Avatar IV motion doubles cost', () => {
  const text = Array(150).fill('word').join(' ');
  const iii = estimateAvatarVideoCredits(text, 'avatar_iii', 1, false);
  const iv = estimateAvatarVideoCredits(text, 'avatar_iv', 1, false);
  const ivMotion = estimateAvatarVideoCredits(text, 'avatar_iv', 1, true);
  assert.ok(iii.durationSeconds >= 60);
  assert.ok(iv.credits > iii.credits);
  assert.equal(ivMotion.credits, iv.credits * 2);
});

test('plan rejects invalid approvals, tuning, IDs, and an estimate above the approved ceiling', () => {
  for (const input of [
    validInput({ confirmCreditUse: false }),
    validInput({ operationId: 'short' }),
    validInput({ idempotencyKey: 'bad key' }),
    validInput({ manifestSha256: 'A'.repeat(64) }),
    validInput({ voiceSettings: { speed: 2 } }),
    validInput({ maxApprovedCredits: 0 }),
    validInput({ maxApprovedCredits: 1, script: Array(300).fill('word').join(' ') }),
  ]) {
    assert.throws(() => buildHeyGenAvatarVideoPlan(input));
  }
});

test('provider parsers normalize only required fields and reject malformed success envelopes', () => {
  assert.deepEqual(parseHeyGenAvatarLook({ data: {
    id: 'look_1', avatar_type: 'digital_twin', group_id: 'group_1', default_voice_id: 'voice_1',
    supported_api_engines: ['avatar_iv', 'avatar_v'], status: 'completed', extra: true,
  } }), {
    id: 'look_1', avatarType: 'digital_twin', groupId: 'group_1', defaultVoiceId: 'voice_1',
    supportedApiEngines: ['avatar_iv', 'avatar_v'], status: 'completed',
  });
  assert.deepEqual(parseHeyGenAvatarGroup({ data: { id: 'group_1', status: 'completed', consent_status: 'approved' } }), {
    id: 'group_1', status: 'completed', consentStatus: 'approved',
  });
  assert.deepEqual(parseHeyGenVoice({ data: { voice_id: 'voice_1', status: 'complete' } }), {
    voiceId: 'voice_1', status: 'complete', failureMessage: null,
  });
  assert.deepEqual(parseHeyGenCreateVideo({ data: { video_id: 'v_1', status: 'pending' } }), {
    videoId: 'v_1', status: 'pending',
  });
  assert.deepEqual(parseHeyGenVideoDetail({ data: {
    id: 'v_1', status: 'completed', video_url: 'https://files2.heygen.ai/video.mp4', duration: 12,
  } }), {
    id: 'v_1', status: 'completed', title: null, videoUrl: 'https://files2.heygen.ai/video.mp4',
    captionedVideoUrl: null, subtitleUrl: null, thumbnailUrl: null, gifUrl: null, duration: 12,
    failureCode: null, failureMessage: null, completedAt: null,
  });
  assert.throws(() => parseHeyGenCreateVideo({ data: { status: 'pending' } }));
});

test('compatibility matrix blocks unsupported engines and invalid motion/expressiveness combinations', () => {
  const digital = {
    id: 'look_1', avatarType: 'digital_twin' as const, groupId: 'group_1', defaultVoiceId: 'voice_1',
    supportedApiEngines: ['avatar_iii', 'avatar_iv', 'avatar_v'] as const, status: 'completed' as const,
  };
  assert.doesNotThrow(() => validateHeyGenAvatarVideoCompatibility(validInput(), { ...digital, supportedApiEngines: [...digital.supportedApiEngines] }));
  assert.throws(() => validateHeyGenAvatarVideoCompatibility(
    validInput({ engine: 'avatar_iv', referenceLookId: undefined, expressiveness: 'high' }),
    { ...digital, supportedApiEngines: [...digital.supportedApiEngines] },
  ));
  assert.throws(() => validateHeyGenAvatarVideoCompatibility(
    validInput({ engine: 'avatar_iii', referenceLookId: undefined, motionPrompt: 'wave' }),
    { ...digital, supportedApiEngines: [...digital.supportedApiEngines] },
  ));
  assert.throws(() => validateHeyGenAvatarVideoCompatibility(
    validInput({ engine: 'avatar_v', expressiveness: 'high' }),
    { ...digital, supportedApiEngines: [...digital.supportedApiEngines] },
  ));
});
