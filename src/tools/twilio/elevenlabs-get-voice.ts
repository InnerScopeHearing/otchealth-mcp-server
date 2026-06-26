import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { elevenGetVoice } from '../../twilio/full-client.js';

export function registerElevenLabsGetVoice(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'elevenlabs_get_voice',
    category: 'read',
    annotations: {
      title: 'Get ElevenLabs voice details',
      description: 'Fetches details for a specific ElevenLabs voice by ID via GET api.elevenlabs.io/v1/voices/{voice_id}. Requires ELEVENLABS_API_KEY at runtime. Read-only.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      voice_id: z.string().min(1).describe('ElevenLabs voice ID (from elevenlabs_list_voices).'),
    },
    outputShape: {
      voice_id: z.string(),
      name: z.string().nullable(),
      category: z.string().nullable(),
      labels: z.unknown(),
    },
    handler: async (input) => {
      const voice = await elevenGetVoice(input.voice_id);
      return {
        data: {
          voice_id: voice.voice_id ?? input.voice_id,
          name: voice.name ?? null,
          category: voice.category ?? null,
          labels: voice.labels ?? {},
        },
        summary: `Voice ${voice.voice_id}: ${voice.name ?? '(no name)'}, category=${voice.category}`,
      };
    },
  }, callerHash);
}
