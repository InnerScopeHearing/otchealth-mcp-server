export const HEYGEN_PROVIDER_WRITE_FLAG = 'ENABLE_HEYGEN_PROVIDER_WRITES' as const;

export const HEYGEN_CREDIT_WRITE_FLAGS = [
  'ENABLE_HEYGEN_PROMPT_AVATAR_WRITES',
  'ENABLE_HEYGEN_AVATAR_VIDEO_WRITES',
  'ENABLE_HEYGEN_REFERENCE_LOOK_WRITES',
  'ENABLE_HEYGEN_VIDEO_AGENT_CHAT_WRITES',
  'ENABLE_HEYGEN_VIDEO_AGENT_GENERATION',
  'ENABLE_HEYGEN_ASSET_WRITES',
  'ENABLE_HEYGEN_TRANSLATION_WRITES',
  'ENABLE_HEYGEN_TTS_WRITES',
] as const;

export type HeyGenCreditWriteFlag = (typeof HEYGEN_CREDIT_WRITE_FLAGS)[number];

/**
 * Two-key provider-spend interlock.
 *
 * A credit-consuming HeyGen provider call is reachable only when the fleet-wide provider-write
 * switch and that exact mutation-family switch are both true. This makes the incident hard stop a
 * single production invariant and prevents one stale per-family env value from reopening spend.
 */
export function isHeyGenProviderWriteEnabled(flag: HeyGenCreditWriteFlag): boolean {
  return process.env[HEYGEN_PROVIDER_WRITE_FLAG] === 'true' && process.env[flag] === 'true';
}
