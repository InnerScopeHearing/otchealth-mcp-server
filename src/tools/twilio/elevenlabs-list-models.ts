import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { elevenListModels } from '../../twilio/full-client.js';

export function registerElevenLabsListModels(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'elevenlabs_list_models',
    category: 'read',
    annotations: {
      title: 'List ElevenLabs TTS models',
      description: 'Lists all available TTS models from ElevenLabs via GET api.elevenlabs.io/v1/models. Requires ELEVENLABS_API_KEY at runtime. Read-only.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {},
    outputShape: {
      models: z.array(z.unknown()),
      count: z.number(),
    },
    handler: async () => {
      const models = await elevenListModels();
      const arr = Array.isArray(models) ? models : [];
      return {
        data: { models: arr, count: arr.length },
        summary: `Found ${arr.length} ElevenLabs model(s).`,
      };
    },
  }, callerHash);
}
