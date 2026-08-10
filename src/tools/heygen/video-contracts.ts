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
}

export interface HeyGenAvatarVideoPlan {
  body: HeyGenCreateVideoBody;
  requestSha256: string;
  scriptSha256: string;
  idempotencyKeySha256: string;
  estimatedDurationSeconds: number;
  estimatedCredits: number;
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

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalize(entry)).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`)
    .join(',')}}`;
}

export function canonicalRequestSha256(body: HeyGenCreateVideoBody): string {
  return sha256(canonicalize(body));
}

function assertString(value: string, field: string, min: number, max: number, preserve = false): string {
  if (typeof value !== 'string' || value.trim().length < min || value.length > max) {
    throw new Error(`${field} must be ${min}-${max} characters.`);
  }
  return preserve ? value : value.trim();
}

export function estimateAvatarVideoCredits(
  script: string,
  engine: HeyGenAvatarEngine,
  speed = 1,
  hasCustomMotion = false,
): { durationSeconds: number; credits: number } {
  const words = script.trim().split(/\s+/).filter(Boolean).length;
  const normalizedSpeed = Number.isFinite(speed) && speed >= 0.5 && speed <= 1.5 ? speed : 1;
  const durationSeconds = Math.max(3, Math.ceil((words / 2.5 / normalizedSpeed) * 1.15));
  const base = engine === 'avatar_iii'
    ? Math.max(1, Math.ceil((durationSeconds / 60) * 3))
    : Math.max(1, Math.ceil(durationSeconds / 3));
  const credits = engine === 'avatar_iv' && hasCustomMotion ? base * 2 : base;
  return { durationSeconds, credits };
}

export function buildHeyGenAvatarVideoPlan(input: HeyGenAvatarVideoCreateInput): HeyGenAvatarVideoPlan {
  if (!HEYGEN_OPERATION_ID_RE.test(input.operationId)) throw new Error('operation_id is invalid.');
  if (!HEYGEN_IDEMPOTENCY_KEY_RE.test(input.idempotencyKey)) throw new Error('idempotency_key is invalid.');
  if (!HEYGEN_SHA256_RE.test(input.manifestSha256)) throw new Error('manifest_sha256 must be lowercase SHA-256.');
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

  const title = assertString(input.title, 'title', 1, 200);
  const script = assertString(input.script, 'script', 1, 10_000, true);
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
  if (estimate.credits > input.maxApprovedCredits) {
    throw new Error(
      `Estimated credit use ${estimate.credits} exceeds max_approved_credits ${input.maxApprovedCredits}.`,
    );
  }

  return {
    body,
    requestSha256: canonicalRequestSha256(body),
    scriptSha256: sha256(script),
    idempotencyKeySha256: sha256(input.idempotencyKey),
    estimatedDurationSeconds: estimate.durationSeconds,
    estimatedCredits: estimate.credits,
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
  return { voiceId: data.voice_id, status: data.status ?? null, failureMessage: data.failure_message ?? null };
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
  if (look.status && look.status !== 'completed') throw new Error(`Avatar look is not completed (${look.status}).`);
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
  if (input.engine === 'avatar_v' && input.expressiveness) {
    throw new Error('Avatar V does not support expressiveness.');
  }
  if (input.referenceLookId && input.engine !== 'avatar_v') {
    throw new Error('reference_look_id is supported only for Avatar V.');
  }
}
