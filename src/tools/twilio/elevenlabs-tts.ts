import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { elevenTextToSpeech } from '../../twilio/full-client.js';
import { ELEVEN_MAX_CHARS, assertElevenTextWithinLimit } from '../../twilio/elevenlabs-models.js';

export function registerElevenLabsTts(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'elevenlabs_tts',
    category: 'write_simple',
    annotations: {
      title: 'ElevenLabs text-to-speech',
      description: 'Converts text to speech using ElevenLabs POST /v1/text-to-speech/{voice_id}. Defaults to model eleven_v4 (10,000 chars per request); eleven_v4_turbo is the half-cost option. Returns base64-encoded MP3 audio. Requires ELEVENLABS_API_KEY at runtime (not in env.ts — checked at runtime; tool is skipped gracefully if absent). Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputShape: {
      voice_id: z.string().min(1).describe('ElevenLabs voice ID. Get IDs from elevenlabs_list_voices.'),
      text: z.string().min(1).max(ELEVEN_MAX_CHARS).describe('Text to convert to speech. Per-request limit depends on the model: eleven_v4 and eleven_v4_turbo 10000, eleven_v3 5000, eleven_multilingual_v2 10000, eleven_flash_v2_5 40000. Oversized text is rejected before any ElevenLabs call.'),
      model_id: z.string().optional().describe('ElevenLabs model ID (default: eleven_v4). Other current options: eleven_v4_turbo (half cost), eleven_v3, eleven_multilingual_v2, eleven_flash_v2_5. Use elevenlabs_list_models for available IDs.'),
      stability: z.number().min(0).max(1).optional().describe('Voice stability 0.0–1.0 (default 0.5). Higher = more consistent.'),
      similarity_boost: z.number().min(0).max(1).optional().describe('Voice similarity boost 0.0–1.0 (default 0.75).'),
      style: z.number().min(0).max(1).optional().describe('Speaking style exaggeration 0.0–1.0 (default 0, off). Ignored on eleven_v4 and eleven_v4_turbo, which support only stability and similarity_boost.'),
      use_speaker_boost: z.boolean().optional().describe('Boost speaker likeness (default true). Adds latency. Ignored on eleven_v4 and eleven_v4_turbo, which support only stability and similarity_boost.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      audio_base64: z.string().nullable(),
      content_type: z.string().nullable(),
      voice_id: z.string(),
    },
    handler: async (input, ctx) => {
      assertElevenTextWithinLimit(input.text, input.model_id);
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, audio_base64: null, content_type: null, voice_id: input.voice_id },
          audit: { before: null, after: { voice_id: input.voice_id, text_length: input.text.length } },
          summary: `DRY RUN: would synthesize ${input.text.length} chars with voice ${input.voice_id}. Pass dry_run=false to apply.`,
        };
      }
      const result = await elevenTextToSpeech({
        voice_id: input.voice_id,
        text: input.text,
        model_id: input.model_id,
        stability: input.stability,
        similarity_boost: input.similarity_boost,
        style: input.style,
        use_speaker_boost: input.use_speaker_boost,
      });
      return {
        data: { executed: true, dry_run: false, audio_base64: result.audio_base64, content_type: result.content_type, voice_id: input.voice_id },
        audit: { before: null, after: { voice_id: input.voice_id, text_length: input.text.length } },
        summary: `Synthesized ${input.text.length} chars with voice ${input.voice_id}. Audio returned as base64 MP3.`,
      };
    },
  }, callerHash);
}
