import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { listBuildHooks } from '../../netlify/full-client.js';

export function registerNetlifyBuildHookList(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'netlify_build_hook_list',
    category: 'read',
    annotations: {
      title: 'Netlify: list build hooks for a site',
      description: 'List all build hooks (deploy webhooks) for a site (GET /sites/{site_id}/build_hooks). Returns IDs, titles, branches, and webhook URLs.',
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      site_id: z.string().min(1).describe('Netlify site ID.'),
    },
    outputShape: {
      hooks: z.array(z.object({
        id: z.string(),
        title: z.string(),
        branch: z.string().nullable(),
        url: z.string().nullable(),
        created_at: z.string().nullable(),
      })),
      count: z.number(),
    },
    handler: async (input, _ctx) => {
      const raw = await listBuildHooks(input.site_id);
      const hooks = (raw ?? []).map((h: any) => ({
        id: h.id ?? '',
        title: h.title ?? '',
        branch: h.branch ?? null,
        url: h.url ?? null,
        created_at: h.created_at ?? null,
      }));
      return {
        data: { hooks, count: hooks.length },
        summary: `Found ${hooks.length} build hook(s) for site ${input.site_id}.`,
      };
    },
  }, callerHash);
}
