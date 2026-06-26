import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { elevenListVoices } from '../../twilio/full-client.js';

export function registerElevenLabsListVoices(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'elevenlabs_list_voices',
    category: 'read',
    annotations: {
      title: 'List ElevenLabs voices',
      description: 'Lists all available voices from the ElevenLabs API via GET api.elevenlabs.io/v1/voices. Requires ELEVENLABS_API_KEY in the server environment (not in env.ts — checked at runtime). Read-only.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {},
    outputShape: {
      voices: z.array(z.unknown()),
      count: z.number(),
    },
    handler: async () => {
      const voices = await elevenListVoices();
      return {
        data: { voices, count: voices.length },
        summary: `Found ${voices.length} ElevenLabs voice(s).`,
      };
    },
  }, callerHash);
}
