import { createHash } from 'node:crypto';
import { z } from 'zod';

export const HEYGEN_OPERATION_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
export const HEYGEN_IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9_.:-]{1,255}$/;
export const HEYGEN_SHA256_RE = /^[a-f0-9]{64}$/;
export const HEYGEN_HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

export type HeyGenAvatarEngine = 'avatar_iii' | 'avatar_iv' | 'avatar_v';
export type HeyGenAvatarType = 'studio_avatar' | 'digital_twin' | 'photo_avatar';
export type HeyGenVideoResolution = '720p' | '1080p';
export type HeyGenVideoAspectRatio = '16:9' | '9:16' | '4:5' | '5:4' | '1:1' | 'auto';
export type HeyGenProductionProfile = 'standard' | 'family_story_final' | 'family_story_photo_fallback';
export type HeyGenFamilyStoryFounder = 'matthew' | 'kimberly' | 'mark';

export interface HeyGenFamilyStoryProfile {
  founder: HeyGenFamilyStoryFounder;
  groupId: string;
  selectedPhotoLookId: string;
  privateVoiceId: string;
  personalizedMotionReferenceLookId: string | null;
}

/** Owner-locked Family Story casting manifest. IDs are verified live again before every dry run. */
export const HEYGEN_FAMILY_STORY_PROFILES: Readonly<Record<HeyGenFamilyStoryFounder, HeyGenFamilyStoryProfile>> = {
  matthew: {
    founder: 'matthew',
    groupId: '81ae4b7368b444d4847ce6f0d3d42674',
    selectedPhotoLookId: '1916ba1b808d49e8829908e29c659469',
    privateVoiceId: '7092904ddda348049fb0eeecf3fdfbb6',
    personalizedMotionReferenceLookId: 'f18ef8e05e564f998b87af7a951fe05a',
  },
  kimberly: {
    founder: 'kimberly',
    groupId: 'ad43b5258baf4328a641a59cfebc15c9',
    selectedPhotoLookId: '3c3f4eabdcac4b70baea8ea3299cdc6b',
    privateVoiceId: '551fec783f294caa97696574d7f6d85e',
    personalizedMotionReferenceLookId: null,
  },
  mark: {
    founder: 'mark',
    groupId: '319e339d9e3949038f0b7c17c4521f00',
    selectedPhotoLookId: '2a75cc08b7a74baba1ed2a468f796436',
    privateVoiceId: '7a301178c14a49ee9a7deb508d36a1ec',
    personalizedMotionReferenceLookId: null,
  },
};

export function findHeyGenFamilyStoryFounderByGroupId(groupId: string | null | undefined): HeyGenFamilyStoryFounder | null {
  if (!groupId) return null;
  return (Object.values(HEYGEN_FAMILY_STORY_PROFILES).find((profile) => profile.groupId === groupId)?.founder) ?? null;
}

export function identifyHeyGenFamilyStoryFounder(input: Pick<
  HeyGenAvatarVideoCreateInput,
  'avatarId' | 'voiceId' | 'referenceLookId'
>): HeyGenFamilyStoryFounder | null {
  const matched = Object.values(HEYGEN_FAMILY_STORY_PROFILES).filter((profile) =>
    input.avatarId === profile.selectedPhotoLookId ||
    input.voiceId === profile.privateVoiceId ||
    (Boolean(input.referenceLookId) && input.referenceLookId === profile.personalizedMotionReferenceLookId),
  );
  if (matched.length === 0) return null;
  const founders = new Set(matched.map((profile) => profile.founder));
  if (founders.size !== 1) throw new Error('Family Story request mixes locked founder identities.');
  return matched[0]!.founder;
}

const ACCEPTED_CONSENT_STATUSES = new Set(['accepted', 'approved', 'complete', 'completed']);

/**
 * Normalize the provider's documented/current completed-consent spellings in one place.
 * Unknown, empty, pending, and rejected values fail closed.
 */
export function isHeyGenConsentAccepted(value: string | null | undefined): boolean {
  if (typeof value !== 'string') return false;
  return ACCEPTED_CONSENT_STATUSES.has(value.trim().toLowerCase());
}

export interface HeyGenVoiceSettings {
  speed?: number;
  pitch?: number;
  volume?: number;
  locale?: string;
}

export interface HeyGenBackgroundColor {
  type: 'color';
  value: string;
}

export interface HeyGenBackgroundImage {
  type: 'image';
  assetId: string;
}

export interface HeyGenCaptionSettings {
  fileFormat: 'srt';
  style?: 'default';
}

export interface HeyGenAvatarVideoCreateInput {
  operationId: string;
  idempotencyKey: string;
  manifestSha256: string;
  title: string;
  avatarId: string;
  voiceId: string;
  script: string;
  engine: HeyGenAvatarEngine;
  productionProfile?: HeyGenProductionProfile;
  familyStoryFounder?: HeyGenFamilyStoryFounder;
  referenceLookId?: string;
  resolution: HeyGenVideoResolution;
  aspectRatio: HeyGenVideoAspectRatio;
  fit?: 'contain' | 'cover';
  motionPrompt?: string;
  expressiveness?: 'low' | 'medium' | 'high';
  background?: HeyGenBackgroundColor | HeyGenBackgroundImage;
  caption?: HeyGenCaptionSettings;
  voiceSettings?: HeyGenVoiceSettings;
  brandGlossaryId?: string;
  confirmCreditUse: boolean;
  confirmedPremiumCreditsBefore: number;
  confirmedBillingSnapshotSha256?: string;
  confirmedBillingStateSha256?: string;
  confirmedBillingObservedAt?: string;
  ownerApprovalJws?: string;
  maxApprovedCredits: number;
  reservePremiumCredits: number;
}

export interface HeyGenCreateVideoBody extends Record<string, unknown> {
  type: 'avatar';
  title: string;
  avatar_id: string;
  voice_id: string;
  script: string;
  engine:
    | { type: 'avatar_iii' }
    | { type: 'avatar_iv' }
    | { type: 'avatar_v'; reference_look_id?: string };
  resolution: HeyGenVideoResolution;
  aspect_ratio: HeyGenVideoAspectRatio;
  output_format: 'mp4';
  callback_id: string;
  fit?: 'contain' | 'cover';
  motion_prompt?: string;
  expressiveness?: 'low' | 'medium' | 'high';
  background?:
    | { type: 'color'; value: string }
    | { type: 'image'; asset_id: string };
  caption?: { file_format: 'srt'; style?: 'default' };
  voice_settings?: HeyGenVoiceSettings;
  brand_glossary_id?: string;
}

export interface HeyGenAvatarLook {
  id: string;
  avatarType: HeyGenAvatarType;
  groupId: string | null;
  defaultVoiceId: string | null;
  supportedApiEngines: HeyGenAvatarEngine[];
  status: 'processing' | 'pending_consent' | 'failed' | 'completed' | null;
}

export interface HeyGenAvatarGroup {
  id: string;
  status: 'processing' | 'pending_consent' | 'failed' | 'completed' | null;
  consentStatus: string | null;
}

export interface HeyGenVoice {
  voiceId: string;
  status: 'processing' | 'complete' | 'failed' | null;
  failureMessage: string | null;
  supportPause: boolean | null;
}

export interface HeyGenAvatarVideoPlan {
  body: HeyGenCreateVideoBody;
  requestSha256: string;
  scriptSha256: string;
  idempotencyKeySha256: string;
  estimatedDurationSeconds: number;
  pauseSeconds: number;
  estimatedCredits: number;
  conservativeCreditCap: number;
  providerCreditCapAvailable: false;
  productionProfile: HeyGenProductionProfile;
  familyStoryFounder?: HeyGenFamilyStoryFounder;
  personalizedMotion: boolean;
}

const AvatarLookEnvelopeSchema = z.object({
  data: z.object({
    id: z.string().min(1),
    avatar_type: z.enum(['studio_avatar', 'digital_twin', 'photo_avatar']),
    group_id: z.string().min(1).nullable().optional(),
    default_voice_id: z.string().min(1).nullable().optional(),
    supported_api_engines: z.array(z.enum(['avatar_iii', 'avatar_iv', 'avatar_v'])).default([]),
    status: z.enum(['processing', 'pending_consent', 'failed', 'completed']).nullable().optional(),
  }).passthrough(),
}).passthrough();

const AvatarGroupEnvelopeSchema = z.object({
  data: z.object({
    id: z.string().min(1),
    status: z.enum(['processing', 'pending_consent', 'failed', 'completed']).nullable().optional(),
    consent_status: z.string().nullable().optional(),
  }).passthrough(),
}).passthrough();

const VoiceEnvelopeSchema = z.object({
  data: z.object({
    voice_id: z.string().min(1),
    status: z.enum(['processing', 'complete', 'failed']).nullable().optional(),
    failure_message: z.string().nullable().optional(),
    support_pause: z.boolean().nullable().optional(),
  }).passthrough(),
}).passthrough();

const CreateVideoEnvelopeSchema = z.object({
  data: z.object({
    video_id: z.string().min(1),
    status: z.string().min(1),
  }).passthrough(),
}).passthrough();

const VideoDetailEnvelopeSchema = z.object({
  data: z.object({
    id: z.string().min(1),
    status: z.enum(['pending', 'processing', 'completed', 'failed']),
    title: z.string().nullable().optional(),
    video_url: z.string().url().nullable().optional(),
    captioned_video_url: z.string().url().nullable().optional(),
    subtitle_url: z.string().url().nullable().optional(),
    thumbnail_url: z.string().url().nullable().optional(),
    gif_url: z.string().url().nullable().optional(),
    duration: z.number().finite().nonnegative().nullable().optional(),
    failure_code: z.string().nullable().optional(),
    failure_message: z.string().nullable().optional(),
    completed_at: z.number().int().nullable().optional(),
  }).passthrough(),
}).passthrough();

export interface HeyGenVideoDetail {
  id: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  title: string | null;
  videoUrl: string | null;
  captionedVideoUrl: string | null;
  subtitleUrl: string | null;
  thumbnailUrl: string | null;
  gifUrl: string | null;
  duration: number | null;
  failureCode: string | null;
  failureMessage: string | null;
  completedAt: number | null;
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalize(entry)).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`)
    .join(',')}}`;
}

export function canonicalJsonSha256(value: unknown): string {
  return sha256(canonicalize(value));
}

export function canonicalRequestSha256(body: HeyGenCreateVideoBody): string {
  return canonicalJsonSha256(body);
}

function assertString(value: string, field: string, min: number, max: number, preserve = false): string {
  if (typeof value !== 'string' || value.trim().length < min || value.length > max) {
    throw new Error(`${field} must be ${min}-${max} characters.`);
  }
  return preserve ? value : value.trim();
}

// Per-minute premium-credit rates HeyGen publishes for each engine/look combination. Source:
// https://help.heygen.com/en/articles/14602974-avatar-v-is-now-available-on-heygen (read 2026-09-03).
// Avatar V is video-look only (HeyGen: "Avatar V is not available for photo-based looks"), so it
// has a single rate. Avatar IV differs by look: a video look (studio_avatar/digital_twin) costs
// more than a photo look. Expressed as numerator-over-60 so integer-second math stays exact.
const HEYGEN_AVATAR_V_CREDITS_PER_MINUTE = 48;
const HEYGEN_AVATAR_IV_VIDEO_LOOK_CREDITS_PER_MINUTE = 31;
const HEYGEN_AVATAR_IV_PHOTO_LOOK_CREDITS_PER_MINUTE = 16;

/**
 * Avatar IV's per-minute rate depends on whether the rendering Look is a photo Look or a video
 * Look (studio_avatar/digital_twin). When the caller has not resolved the Look yet (the
 * pre-submission conservative cap is computed before the gateway fetches the live Look via
 * GET /v3/avatars/looks/{id}), the type is unknown -- fail toward the higher video-look rate so
 * the cap never under-estimates real provider billing.
 */
function heygenAvatarIvCreditsPerMinute(lookAvatarType?: HeyGenAvatarType | null): number {
  return lookAvatarType === 'photo_avatar'
    ? HEYGEN_AVATAR_IV_PHOTO_LOOK_CREDITS_PER_MINUTE
    : HEYGEN_AVATAR_IV_VIDEO_LOOK_CREDITS_PER_MINUTE;
}

export function conservativeAvatarVideoCreditCap(
  durationSeconds: number,
  engine: HeyGenAvatarEngine,
  hasCustomMotion = false,
  lookAvatarType?: HeyGenAvatarType | null,
): number {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new Error('durationSeconds must be positive and finite.');
  }
  let avatarCredits: number;
  if (engine === 'avatar_iii') {
    avatarCredits = Math.max(1, Math.ceil((durationSeconds / 60) * 3));
  } else if (engine === 'avatar_v') {
    avatarCredits = Math.max(1, Math.ceil((durationSeconds * HEYGEN_AVATAR_V_CREDITS_PER_MINUTE) / 60));
  } else {
    avatarCredits = Math.max(
      1,
      Math.ceil((durationSeconds * heygenAvatarIvCreditsPerMinute(lookAvatarType)) / 60),
    );
  }
  const motionAdjusted = engine === 'avatar_iv' && hasCustomMotion ? avatarCredits * 2 : avatarCredits;
  // Conservative subscription bound: the 2026-08-09 owner-approved direct Avatar IV canary had a
  // six-second local estimate but an actual 4.62367-second output and a three-credit debit despite
  // the (then-assumed) published one-credit-per-three-seconds rate. A fixed one-credit safety
  // allowance captures the observed provider/TTS/rounding overhead on top of HeyGen's real
  // published per-minute rates (corrected 2026-09-03, see the rate constants above). The API
  // exposes no provider-enforced credit cap.
  return motionAdjusted + 1;
}

export function parseHeyGenBreakSeconds(script: string): number {
  let seconds = 0;
  const breakTag = /<break\s+time=["']([0-9]+(?:\.[0-9]+)?)s["']\s*\/>/gi;
  for (const match of script.matchAll(breakTag)) seconds += Number(match[1]);
  return seconds;
}

export function estimateAvatarVideoCredits(
  script: string,
  engine: HeyGenAvatarEngine,
  speed = 1,
  hasCustomMotion = false,
  lookAvatarType?: HeyGenAvatarType | null,
): { durationSeconds: number; pauseSeconds: number; credits: number } {
  const pauseSeconds = parseHeyGenBreakSeconds(script);
  const spokenText = script.replace(/<break\s+time=["'][0-9]+(?:\.[0-9]+)?s["']\s*\/>/gi, ' ');
  const words = spokenText.trim().split(/\s+/).filter(Boolean).length;
  const normalizedSpeed = Number.isFinite(speed) && speed >= 0.5 && speed <= 1.5 ? speed : 1;
  const spokenSeconds = Math.max(3, Math.ceil((words / 2.5 / normalizedSpeed) * 1.15));
  const durationSeconds = Math.ceil(spokenSeconds + pauseSeconds);
  const credits = conservativeAvatarVideoCreditCap(durationSeconds, engine, hasCustomMotion, lookAvatarType);
  return { durationSeconds, pauseSeconds, credits };
}

export function validateHeyGenFamilyStoryProductionContract(
  input: HeyGenAvatarVideoCreateInput,
  options: { legacyTerminalReplay?: boolean } = {},
): void {
  const productionProfile = input.productionProfile ?? 'standard';
  const lockedFounder = identifyHeyGenFamilyStoryFounder(input);
  if (productionProfile === 'standard') {
    if (input.familyStoryFounder) throw new Error('family_story_founder requires a Family Story production profile.');
    if (lockedFounder && !options.legacyTerminalReplay) {
      throw new Error(`Locked Family Story ${lockedFounder} assets require an explicit Family Story production profile.`);
    }
    return;
  }
  if (!input.familyStoryFounder) throw new Error('family_story_founder is required for a Family Story production profile.');
  if (lockedFounder && lockedFounder !== input.familyStoryFounder) {
    throw new Error('Family Story profile does not match the locked founder assets.');
  }
  const profile = HEYGEN_FAMILY_STORY_PROFILES[input.familyStoryFounder];
  if (input.engine !== 'avatar_v') throw new Error('Final Family Story founder renders require Avatar V.');
  if (input.resolution !== '1080p') throw new Error('Family Story founder renders require 1080p; Avatar IV/V 4K is unavailable.');
  if (input.aspectRatio !== '16:9') throw new Error('Family Story founder renders require 16:9.');
  if (input.avatarId !== profile.selectedPhotoLookId) {
    throw new Error(`Family Story ${profile.founder} requires the owner-selected photo Look.`);
  }
  if (input.voiceId !== profile.privateVoiceId) {
    throw new Error(`Family Story ${profile.founder} requires the exact matched private voice.`);
  }
  if (input.expressiveness) throw new Error('Avatar V Family Story renders must not include expressiveness.');
  const voice = input.voiceSettings;
  if (
    (voice?.speed !== undefined && voice.speed !== 1) ||
    (voice?.pitch !== undefined && voice.pitch !== 0) ||
    (voice?.volume !== undefined && voice.volume !== 1)
  ) {
    throw new Error('Family Story founder audio must use natural voice tuning (speed 1, pitch 0, volume 1 or omitted).');
  }

  if (productionProfile === 'family_story_final') {
    if (!profile.personalizedMotionReferenceLookId) {
      throw new Error(
        `Family Story ${profile.founder} final-quality personalized motion is blocked until consent is completed and an eligible same-group Digital Twin reference is verified.`,
      );
    }
    if (input.referenceLookId !== profile.personalizedMotionReferenceLookId) {
      throw new Error(`Family Story ${profile.founder} final-quality render requires the owner-approved same-group Digital Twin reference.`);
    }
    return;
  }

  if (input.familyStoryFounder === 'matthew') {
    throw new Error('Matthew has an eligible personalized-motion reference; do not downgrade him to photo fallback.');
  }
  if (input.referenceLookId) throw new Error('Family Story photo fallback must omit reference_look_id.');
  if (input.motionPrompt) throw new Error('Family Story photo fallback must omit motion_prompt because no eligible reference exists.');
}

export function buildHeyGenAvatarVideoPlan(
  input: HeyGenAvatarVideoCreateInput,
  options: { legacyTerminalReplay?: boolean } = {},
): HeyGenAvatarVideoPlan {
  if (!HEYGEN_OPERATION_ID_RE.test(input.operationId)) throw new Error('operation_id is invalid.');
  if (!HEYGEN_IDEMPOTENCY_KEY_RE.test(input.idempotencyKey)) throw new Error('idempotency_key is invalid.');
  if (!HEYGEN_SHA256_RE.test(input.manifestSha256)) throw new Error('manifest_sha256 must be lowercase SHA-256.');
  if (input.confirmedBillingSnapshotSha256 && !HEYGEN_SHA256_RE.test(input.confirmedBillingSnapshotSha256)) {
    throw new Error('confirmed_billing_snapshot_sha256 must be lowercase SHA-256.');
  }
  if (input.confirmedBillingStateSha256 && !HEYGEN_SHA256_RE.test(input.confirmedBillingStateSha256)) {
    throw new Error('confirmed_billing_state_sha256 must be lowercase SHA-256.');
  }
  if (input.confirmedBillingObservedAt && !Number.isFinite(Date.parse(input.confirmedBillingObservedAt))) {
    throw new Error('confirmed_billing_observed_at must be an ISO timestamp.');
  }
  if (input.confirmCreditUse !== true) throw new Error('confirm_credit_use=true is required.');
  for (const [name, value] of [
    ['confirmed_premium_credits_before', input.confirmedPremiumCreditsBefore],
    ['max_approved_credits', input.maxApprovedCredits],
    ['reserve_premium_credits', input.reservePremiumCredits],
  ] as const) {
    if (!Number.isInteger(value) || value < (name === 'max_approved_credits' ? 1 : 0)) {
      throw new Error(`${name} is invalid.`);
    }
  }
  validateHeyGenFamilyStoryProductionContract(input, options);

  const title = assertString(input.title, 'title', 1, 200);
  const script = assertString(input.script, 'script', 1, 10_000, true);
  if ((input.productionProfile ?? 'standard') !== 'standard') {
    const withoutBreakTags = script.replace(/<break\s+time=["'][0-9]+(?:\.[0-9]+)?s["']\s*\/>/gi, '');
    if (/[<>]/.test(withoutBreakTags)) {
      throw new Error('Family Story scripts allow plain text plus <break time="Ns"/> pause tags only.');
    }
  }
  assertString(input.avatarId, 'avatar_id', 1, 255);
  assertString(input.voiceId, 'voice_id', 1, 255);
  if (input.referenceLookId) assertString(input.referenceLookId, 'reference_look_id', 1, 255);
  if (input.brandGlossaryId) assertString(input.brandGlossaryId, 'brand_glossary_id', 1, 255);
  if (input.motionPrompt && input.motionPrompt.length > 500) throw new Error('motion_prompt exceeds 500 characters.');

  const voiceSettings = input.voiceSettings;
  if (voiceSettings) {
    if (voiceSettings.speed !== undefined && (voiceSettings.speed < 0.5 || voiceSettings.speed > 1.5)) {
      throw new Error('voice_settings.speed must be 0.5-1.5.');
    }
    if (voiceSettings.pitch !== undefined && (voiceSettings.pitch < -50 || voiceSettings.pitch > 50)) {
      throw new Error('voice_settings.pitch must be -50 to 50.');
    }
    if (voiceSettings.volume !== undefined && (voiceSettings.volume < 0 || voiceSettings.volume > 1)) {
      throw new Error('voice_settings.volume must be 0-1.');
    }
  }

  let engine: HeyGenCreateVideoBody['engine'];
  if (input.engine === 'avatar_v') {
    engine = { type: 'avatar_v' };
    if (input.referenceLookId) engine.reference_look_id = input.referenceLookId;
  } else {
    engine = { type: input.engine };
  }

  const body: HeyGenCreateVideoBody = {
    type: 'avatar',
    title,
    avatar_id: input.avatarId,
    voice_id: input.voiceId,
    script,
    engine,
    resolution: input.resolution,
    aspect_ratio: input.aspectRatio,
    output_format: 'mp4',
    callback_id: input.operationId,
  };
  if (input.fit) body.fit = input.fit;
  if (input.motionPrompt) body.motion_prompt = input.motionPrompt.trim();
  if (input.expressiveness) body.expressiveness = input.expressiveness;
  if (input.background?.type === 'color') {
    if (!HEYGEN_HEX_COLOR_RE.test(input.background.value)) throw new Error('background color must be #RRGGBB.');
    body.background = { type: 'color', value: input.background.value.toLowerCase() };
  } else if (input.background?.type === 'image') {
    assertString(input.background.assetId, 'background.asset_id', 1, 255);
    body.background = { type: 'image', asset_id: input.background.assetId };
  }
  if (input.caption) {
    body.caption = { file_format: input.caption.fileFormat };
    if (input.caption.style) body.caption.style = input.caption.style;
  }
  if (voiceSettings) body.voice_settings = { ...voiceSettings };
  if (input.brandGlossaryId) body.brand_glossary_id = input.brandGlossaryId;

  const estimate = estimateAvatarVideoCredits(
    script,
    input.engine,
    input.voiceSettings?.speed,
    Boolean(input.motionPrompt),
  );
  if (!options.legacyTerminalReplay && estimate.credits > input.maxApprovedCredits) {
    throw new Error(
      `Estimated credit use ${estimate.credits} exceeds max_approved_credits ${input.maxApprovedCredits}.`,
    );
  }
  const productionProfile = input.productionProfile ?? 'standard';
  if (!options.legacyTerminalReplay && productionProfile !== 'standard' && input.maxApprovedCredits !== estimate.credits) {
    throw new Error(
      `Family Story max_approved_credits must equal the conservative cap ${estimate.credits}; received ${input.maxApprovedCredits}.`,
    );
  }

  const requestSha256 = productionProfile === 'standard'
    ? canonicalRequestSha256(body)
    : canonicalJsonSha256({
        provider_body: body,
        production_profile: productionProfile,
        family_story_founder: input.familyStoryFounder,
      });

  return {
    body,
    requestSha256,
    scriptSha256: sha256(script),
    idempotencyKeySha256: sha256(input.idempotencyKey),
    estimatedDurationSeconds: estimate.durationSeconds,
    pauseSeconds: estimate.pauseSeconds,
    estimatedCredits: estimate.credits,
    conservativeCreditCap: estimate.credits,
    providerCreditCapAvailable: false,
    productionProfile,
    familyStoryFounder: input.familyStoryFounder,
    personalizedMotion: Boolean(input.referenceLookId),
  };
}

export function parseHeyGenAvatarLook(value: unknown): HeyGenAvatarLook {
  const data = AvatarLookEnvelopeSchema.parse(value).data;
  return {
    id: data.id,
    avatarType: data.avatar_type,
    groupId: data.group_id ?? null,
    defaultVoiceId: data.default_voice_id ?? null,
    supportedApiEngines: data.supported_api_engines,
    status: data.status ?? null,
  };
}

const READY_CONSENT_STATUSES = new Set(['accepted', 'approved', 'complete', 'completed']);

/**
 * Match only HeyGen's observed ready values (case-insensitive, without trimming). Missing/null
 * consent preserves the existing photo-avatar path where the provider does not require consent;
 * every present unrecognized value
 * (including blank) fails closed.
 */
export function isHeyGenConsentStatusReady(consentStatus: string | null): boolean {
  if (consentStatus === null) return true;
  return READY_CONSENT_STATUSES.has(consentStatus.toLowerCase());
}

export function parseHeyGenAvatarGroup(value: unknown): HeyGenAvatarGroup {
  const data = AvatarGroupEnvelopeSchema.parse(value).data;
  return { id: data.id, status: data.status ?? null, consentStatus: data.consent_status ?? null };
}

export function parseHeyGenVoice(value: unknown): HeyGenVoice {
  const data = VoiceEnvelopeSchema.parse(value).data;
  return {
    voiceId: data.voice_id,
    status: data.status ?? null,
    failureMessage: data.failure_message ?? null,
    supportPause: data.support_pause ?? null,
  };
}

export function parseHeyGenCreateVideo(value: unknown): { videoId: string; status: string } {
  const data = CreateVideoEnvelopeSchema.parse(value).data;
  return { videoId: data.video_id, status: data.status };
}

export function parseHeyGenVideoDetail(value: unknown): HeyGenVideoDetail {
  const data = VideoDetailEnvelopeSchema.parse(value).data;
  return {
    id: data.id,
    status: data.status,
    title: data.title ?? null,
    videoUrl: data.video_url ?? null,
    captionedVideoUrl: data.captioned_video_url ?? null,
    subtitleUrl: data.subtitle_url ?? null,
    thumbnailUrl: data.thumbnail_url ?? null,
    gifUrl: data.gif_url ?? null,
    duration: data.duration ?? null,
    failureCode: data.failure_code ?? null,
    failureMessage: data.failure_message ?? null,
    completedAt: data.completed_at ?? null,
  };
}

export function validateHeyGenAvatarVideoCompatibility(input: HeyGenAvatarVideoCreateInput, look: HeyGenAvatarLook): void {
  if (look.status !== 'completed') throw new Error(`Avatar look is not completed (${look.status ?? 'missing'}).`);
  if (!look.groupId) throw new Error('Avatar look has no group_id.');
  if (!look.supportedApiEngines.includes(input.engine)) {
    throw new Error(`Avatar look does not support ${input.engine}.`);
  }
  if (input.engine === 'avatar_iii') {
    if (input.motionPrompt || input.expressiveness) {
      throw new Error('Avatar III does not support motion_prompt or expressiveness.');
    }
  }
  if (input.engine === 'avatar_iv') {
    if (input.motionPrompt && look.avatarType !== 'photo_avatar') {
      throw new Error('Avatar IV motion_prompt is supported only for photo avatars.');
    }
    if (input.expressiveness && look.avatarType !== 'photo_avatar') {
      throw new Error('Avatar IV expressiveness is supported only for photo avatars.');
    }
  }
  if (input.engine === 'avatar_v') {
    if (input.expressiveness) throw new Error('Avatar V does not support expressiveness.');
    if (input.motionPrompt && !input.referenceLookId) {
      throw new Error('Avatar V motion_prompt requires an eligible same-group Digital Twin animation reference.');
    }
  }
  if (input.referenceLookId && input.engine !== 'avatar_v') {
    throw new Error('reference_look_id is supported only for Avatar V.');
  }
}
