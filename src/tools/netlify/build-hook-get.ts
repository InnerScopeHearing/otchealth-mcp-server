import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { getBuildHook } from '../../netlify/full-client.js';

export function registerNetlifyBuildHookGet(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'netlify_build_hook_get',
    category: 'read',
    annotations: {
      title: 'Netlify: get build hook details',
      description: 'Fetch details for a single build hook by ID (GET /sites/{site_id}/build_hooks/{id}).',
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      site_id: z.string().min(1).describe('Netlify site ID.'),
      hook_id: z.string().min(1).describe('Build hook ID.'),
    },
    outputShape: {
      id: z.string(),
      title: z.string(),
      branch: z.string().nullable(),
      url: z.string().nullable(),
      created_at: z.string().nullable(),
    },
    handler: async (input, _ctx) => {
      const h = await getBuildHook(input.site_id, input.hook_id);
      return {
        data: {
          id: h.id ?? '',
          title: h.title ?? '',
          branch: h.branch ?? null,
          url: h.url ?? null,
          created_at: h.created_at ?? null,
        },
        summary: `Build hook "${h.title}" (${h.id}) for site ${input.site_id}.`,
      };
    },
  }, callerHash);
}
