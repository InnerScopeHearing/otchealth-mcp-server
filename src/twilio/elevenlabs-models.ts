/**
 * ElevenLabs TTS model defaults and per-request character limits.
 *
 * Limits come from https://elevenlabs.io/docs/overview/models.md (verified 2026-09-29).
 * Unknown model ids are NOT rejected here (ElevenLabs adds models often); they fall back to
 * the largest known limit so only genuinely oversized requests are stopped locally.
 */
export const ELEVEN_DEFAULT_MODEL = 'eleven_v4';

export const ELEVEN_MODEL_CHAR_LIMITS: Record<string, number> = {
  eleven_v4: 10_000,
  eleven_v4_turbo: 10_000,
  eleven_v3: 5_000,
  eleven_v3_conversational: 5_000,
  eleven_multilingual_v2: 10_000,
  eleven_flash_v2_5: 40_000,
  eleven_flash_v2: 30_000,
  eleven_turbo_v2_5: 40_000,
};

/** Largest documented per-request limit; the schema-level ceiling and unknown-model fallback. */
export const ELEVEN_MAX_CHARS = 40_000;

export function elevenModelCharLimit(modelId: string): number {
  return ELEVEN_MODEL_CHAR_LIMITS[modelId] ?? ELEVEN_MAX_CHARS;
}

/** Throws a clear local error instead of letting ElevenLabs reject (or bill) an oversized request. */
export function assertElevenTextWithinLimit(text: string, modelId: string | undefined): void {
  const model = modelId ?? ELEVEN_DEFAULT_MODEL;
  const limit = elevenModelCharLimit(model);
  if (text.length > limit) {
    throw new Error(
      `ElevenLabs model ${model} accepts at most ${limit} characters per request; got ${text.length}. ` +
        `Split the text, or use a model with a larger limit (eleven_flash_v2_5 allows ${ELEVEN_MAX_CHARS}).`,
    );
  }
}
