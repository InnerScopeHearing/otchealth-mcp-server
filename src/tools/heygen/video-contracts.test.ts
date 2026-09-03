import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildHeyGenAvatarVideoPlan,
  canonicalRequestSha256,
  conservativeAvatarVideoCreditCap,
  estimateAvatarVideoCredits,
  HEYGEN_FAMILY_STORY_PROFILES,
  isHeyGenConsentAccepted,
  isHeyGenConsentStatusReady,
  parseHeyGenBreakSeconds,
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

test('completed consent normalization accepts current provider spellings and fails closed otherwise', () => {
  for (const value of ['accepted', 'Accepted', ' approved ', 'complete', 'completed']) {
    assert.equal(isHeyGenConsentAccepted(value), true, value);
  }
  for (const value of [null, undefined, '', 'pending', 'pending_consent', 'rejected', 'unknown']) {
    assert.equal(isHeyGenConsentAccepted(value), false, String(value));
  }
});

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
  assert.equal(ivMotion.credits, (iv.credits - 1) * 2 + 1);
});

test('Avatar IV six-second canary uses a five-credit conservative bound under the published 31-credits-per-minute video-look rate', () => {
  // Corrected 2026-09-03 per HeyGen's published per-look credit rates
  // (https://help.heygen.com/en/articles/14602974-avatar-v-is-now-available-on-heygen): Avatar IV
  // with a video look (studio_avatar/digital_twin, or an unresolved look) costs 31 credits/minute.
  // 6 s: ceil(6*31/60) = ceil(3.1) = 4, +1 safety credit = 5. This was 3 before the 2026-09-03 rate
  // correction (when the estimator assumed a flat one-credit-per-three-seconds rate); the original
  // 591-to-588 incident that motivated the safety credit is unchanged and documented on
  // conservativeAvatarVideoCreditCap.
  const script = 'one two three four five six seven eight nine ten eleven twelve';
  const estimate = estimateAvatarVideoCredits(script, 'avatar_iv', 1, false);
  assert.equal(estimate.durationSeconds, 6);
  assert.equal(estimate.credits, 5);
  assert.throws(() => buildHeyGenAvatarVideoPlan(validInput({
    script,
    engine: 'avatar_iv',
    referenceLookId: undefined,
    maxApprovedCredits: 2,
    motionPrompt: undefined,
  })), /exceeds max_approved_credits 2/);
});

test('Avatar V conservative cap rounds provider duration upward and includes the observed safety credit', () => {
  // Rates corrected 2026-09-03 to HeyGen's published 48 credits/minute for Avatar V
  // (https://help.heygen.com/en/articles/14602974-avatar-v-is-now-available-on-heygen). At 48/60
  // credits/sec, exact-duration boundaries fall at multiples of 1.25 s (5 s -> 4.0 exactly), not the
  // old rate's multiples of 3 s.
  assert.equal(conservativeAvatarVideoCreditCap(5, 'avatar_v'), 5);
  assert.equal(conservativeAvatarVideoCreditCap(5.000001, 'avatar_v'), 6);
  assert.equal(conservativeAvatarVideoCreditCap(4.62367, 'avatar_v'), 5);
  assert.equal(conservativeAvatarVideoCreditCap(6, 'avatar_v'), 6);
  assert.equal(conservativeAvatarVideoCreditCap(6.000001, 'avatar_v'), 6);
  assert.throws(() => conservativeAvatarVideoCreditCap(0, 'avatar_v'));
});

test('historical Moore-family Avatar V dry-run receipts map to corrected conservative maxima', () => {
  // correctedCap re-corrected 2026-09-03 to HeyGen's published 48 credits/minute Avatar V rate
  // (https://help.heygen.com/en/articles/14602974-avatar-v-is-now-available-on-heygen), replacing
  // the interim one-credit-per-three-seconds-plus-safety-credit maxima below.
  // 6 s: ceil(6*48/60) = ceil(4.8) = 5, +1 safety credit = 6 (was 3).
  // 7 s: ceil(7*48/60) = ceil(5.6) = 6, +1 safety credit = 7 (was 4).
  const cases = [
    {
      founder: 'kimberly' as const,
      lookId: '3c3f4eabdcac4b70baea8ea3299cdc6b',
      voiceId: '551fec783f294caa97696574d7f6d85e',
      referenceLookId: undefined,
      historicalRequestSha256: 'de5d7142aab962f341a58b5d2d57e5297da274f4d88e15ced60efacc848e20ce',
      durationSeconds: 6,
      historicalEstimate: 2,
      correctedCap: 6,
    },
    {
      founder: 'mark' as const,
      lookId: '2a75cc08b7a74baba1ed2a468f796436',
      voiceId: '7a301178c14a49ee9a7deb508d36a1ec',
      referenceLookId: undefined,
      historicalRequestSha256: 'fd24b6fbdcdc1e28f696117dcb6a68561da5f7b24ccbc1a8afb38efea813337a',
      durationSeconds: 7,
      historicalEstimate: 3,
      correctedCap: 7,
    },
    {
      founder: 'matthew' as const,
      lookId: '1916ba1b808d49e8829908e29c659469',
      voiceId: '7092904ddda348049fb0eeecf3fdfbb6',
      referenceLookId: 'f18ef8e05e564f998b87af7a951fe05a',
      historicalRequestSha256: 'c31a0562dd8a0d041b28d3a154e6a97277cc793673e70a39515f40be9fa0fdab',
      durationSeconds: 6,
      historicalEstimate: 2,
      correctedCap: 6,
    },
  ];
  for (const receipt of cases) {
    const profile = HEYGEN_FAMILY_STORY_PROFILES[receipt.founder];
    assert.equal(receipt.lookId, profile.selectedPhotoLookId);
    assert.equal(receipt.voiceId, profile.privateVoiceId);
    assert.equal(receipt.referenceLookId ?? null, profile.personalizedMotionReferenceLookId);
    assert.match(receipt.historicalRequestSha256, /^[a-f0-9]{64}$/);
    assert.equal(
      conservativeAvatarVideoCreditCap(receipt.durationSeconds, 'avatar_v'),
      receipt.correctedCap,
    );
    assert.ok(receipt.historicalEstimate < receipt.correctedCap, `${receipt.founder} old estimate must be rejected`);
  }
});

test('Avatar V six-second dry run rejects the old two-credit maximum', () => {
  const script = 'one two three four five six seven eight nine ten eleven twelve';
  const estimate = estimateAvatarVideoCredits(script, 'avatar_v', 1, false);
  // 2026-09-03: 48 credits/minute -> ceil(6*48/60)=5, +1 safety credit = 6 (was 3).
  assert.deepEqual(estimate, { durationSeconds: 6, pauseSeconds: 0, credits: 6 });
  assert.throws(() => buildHeyGenAvatarVideoPlan(validInput({ script, maxApprovedCredits: 2 })), /exceeds max_approved_credits 2/);
});

test('Matthew Family Story final contract locks Avatar V, exact casting, 1080p 16:9, reference, natural audio, and exact cap', () => {
  const matt = HEYGEN_FAMILY_STORY_PROFILES.matthew;
  const script = 'one two three four five six seven eight nine ten eleven twelve';
  const base = validInput({
    script,
    productionProfile: 'family_story_final',
    familyStoryFounder: 'matthew',
    avatarId: matt.selectedPhotoLookId,
    voiceId: matt.privateVoiceId,
    referenceLookId: matt.personalizedMotionReferenceLookId!,
    resolution: '1080p',
    aspectRatio: '16:9',
    motionPrompt: undefined,
    expressiveness: undefined,
    voiceSettings: { speed: 1, pitch: 0, volume: 1, locale: 'en-US' },
    // 2026-09-03: Avatar V is 48 credits/minute; 6 s -> ceil(4.8)+1 = 6 (was 3).
    maxApprovedCredits: 6,
  });
  const plan = buildHeyGenAvatarVideoPlan(base);
  assert.deepEqual(plan.body.engine, { type: 'avatar_v', reference_look_id: matt.personalizedMotionReferenceLookId });
  assert.equal(plan.productionProfile, 'family_story_final');
  assert.equal(plan.familyStoryFounder, 'matthew');
  assert.equal(plan.personalizedMotion, true);
  assert.equal(plan.conservativeCreditCap, 6);
  assert.equal(plan.providerCreditCapAvailable, false);
  assert.equal(Object.hasOwn(plan.body, 'expressiveness'), false);
  assert.equal(Object.hasOwn(plan.body, 'motion_prompt'), false);
  assert.equal(parseHeyGenBreakSeconds('Hello <break time="0.35s"/> world <break time="2s"/>.'), 2.35);
  const pausePlan = buildHeyGenAvatarVideoPlan({
    ...base,
    script: 'Hello <break time="60s"/> world.',
    // 2026-09-03: 63 s at 48 credits/minute -> ceil(63*48/60)=ceil(50.4)=51, +1 safety credit = 52
    // (was 22 under the old one-credit-per-three-seconds rate).
    maxApprovedCredits: 52,
  });
  assert.equal(pausePlan.pauseSeconds, 60);
  assert.equal(pausePlan.estimatedDurationSeconds, 63);
  assert.equal(pausePlan.conservativeCreditCap, 52);
  assert.throws(() => buildHeyGenAvatarVideoPlan({
    ...base,
    script: 'Hello <break time="60s"/> world.',
    maxApprovedCredits: 2,
  }), /exceeds max_approved_credits 2/);
  assert.throws(() => buildHeyGenAvatarVideoPlan({
    ...base,
    script: '<prosody rate="slow">Hello.</prosody>',
  }), /plain text plus <break/);
  assert.notEqual(
    canonicalRequestSha256(plan.body),
    plan.requestSha256,
    'family quality profile and founder must be included in the owner-grant request hash',
  );
  assert.throws(() => buildHeyGenAvatarVideoPlan({
    ...base,
    productionProfile: undefined,
    familyStoryFounder: undefined,
  }), /require an explicit Family Story production profile/);

  for (const override of [
    { engine: 'avatar_iv' as const },
    { resolution: '720p' as const },
    { aspectRatio: 'auto' as const },
    { avatarId: 'wrong_look' },
    { voiceId: 'wrong_voice' },
    { referenceLookId: 'wrong_reference' },
    { expressiveness: 'low' as const },
    { voiceSettings: { speed: 1.1 } },
    { maxApprovedCredits: 2 },
    { maxApprovedCredits: 4 },
  ]) {
    assert.throws(() => buildHeyGenAvatarVideoPlan({ ...base, ...override }));
  }
});

test('Kimberly and Mark final personalized motion remain blocked while a separately labeled photo fallback stays reference-free', () => {
  const script = 'one two three four five six seven eight nine ten eleven twelve';
  for (const founder of ['kimberly', 'mark'] as const) {
    const profile = HEYGEN_FAMILY_STORY_PROFILES[founder];
    const common = validInput({
      script,
      familyStoryFounder: founder,
      avatarId: profile.selectedPhotoLookId,
      voiceId: profile.privateVoiceId,
      referenceLookId: undefined,
      resolution: '1080p',
      aspectRatio: '16:9',
      motionPrompt: undefined,
      expressiveness: undefined,
      voiceSettings: { speed: 1, pitch: 0, volume: 1, locale: 'en-US' },
      // 2026-09-03: Avatar V is 48 credits/minute; 6 s -> ceil(4.8)+1 = 6 (was 3).
      maxApprovedCredits: 6,
    });
    assert.throws(
      () => buildHeyGenAvatarVideoPlan({ ...common, productionProfile: 'family_story_final' }),
      /blocked until consent is completed and an eligible same-group Digital Twin reference is verified/,
    );
    const fallback = buildHeyGenAvatarVideoPlan({ ...common, productionProfile: 'family_story_photo_fallback' });
    assert.equal(fallback.personalizedMotion, false);
    assert.deepEqual(fallback.body.engine, { type: 'avatar_v' });
    assert.throws(() => buildHeyGenAvatarVideoPlan({
      ...common,
      productionProfile: 'family_story_photo_fallback',
      motionPrompt: 'Wave gently.',
    }), /must omit motion_prompt/);
  }
  const matt = HEYGEN_FAMILY_STORY_PROFILES.matthew;
  assert.throws(() => buildHeyGenAvatarVideoPlan(validInput({
    script,
    productionProfile: 'family_story_photo_fallback',
    familyStoryFounder: 'matthew',
    avatarId: matt.selectedPhotoLookId,
    voiceId: matt.privateVoiceId,
    referenceLookId: undefined,
    resolution: '1080p',
    aspectRatio: '16:9',
    motionPrompt: undefined,
    voiceSettings: { speed: 1, pitch: 0, volume: 1 },
    maxApprovedCredits: 3,
  })), /do not downgrade/);
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
  assert.deepEqual(parseHeyGenVoice({ data: { voice_id: 'voice_1', status: 'complete', support_pause: true } }), {
    voiceId: 'voice_1', status: 'complete', failureMessage: null, supportPause: true,
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

test('consent readiness accepts exact provider-ready values and fails closed on pending or unknown states', () => {
  for (const ready of ['accepted', 'approved', 'complete', 'completed', 'ACCEPTED']) {
    assert.equal(isHeyGenConsentStatusReady(ready), true, `${JSON.stringify(ready)} should be ready`);
  }
  assert.equal(isHeyGenConsentStatusReady(null), true, 'missing consent preserves the no-consent photo-avatar path');
  for (const blocked of ['pending', 'pending_consent', 'rejected', 'unknown', '', ' ', ' accepted ']) {
    assert.equal(isHeyGenConsentStatusReady(blocked), false, `${JSON.stringify(blocked)} must fail closed`);
  }
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
  assert.throws(() => validateHeyGenAvatarVideoCompatibility(
    validInput({ engine: 'avatar_v', referenceLookId: undefined, motionPrompt: 'Wave gently.' }),
    { ...digital, supportedApiEngines: [...digital.supportedApiEngines] },
  ), /requires an eligible same-group Digital Twin animation reference/);
  const photo = {
    ...digital,
    avatarType: 'photo_avatar' as const,
    supportedApiEngines: [...digital.supportedApiEngines],
  };
  assert.doesNotThrow(() => validateHeyGenAvatarVideoCompatibility(
    validInput({ engine: 'avatar_v', referenceLookId: undefined, motionPrompt: undefined }),
    photo,
  ));
  assert.throws(() => validateHeyGenAvatarVideoCompatibility(
    validInput({ engine: 'avatar_v', referenceLookId: undefined, motionPrompt: 'Wave gently.' }),
    photo,
  ), /requires an eligible same-group Digital Twin animation reference/);
  assert.doesNotThrow(() => validateHeyGenAvatarVideoCompatibility(
    validInput({ engine: 'avatar_v', referenceLookId: 'ref_1', motionPrompt: 'Wave gently.' }),
    photo,
  ));
});
