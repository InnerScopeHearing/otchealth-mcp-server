import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { listSnippets } from '../../netlify/full-client.js';

export function registerNetlifySnippetList(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'netlify_snippet_list',
    category: 'read',
    annotations: {
      title: 'Netlify: list site snippets',
      description: 'List HTML snippets injected into a site (GET /sites/{site_id}/snippets). Snippets inject code into <head> or before </body>.',
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      site_id: z.string().min(1).describe('Netlify site ID.'),
    },
    outputShape: {
      snippets: z.array(z.object({
        id: z.number(),
        title: z.string(),
        general: z.string().nullable(),
        general_position: z.string().nullable(),
        goal: z.string().nullable(),
        goal_position: z.string().nullable(),
      })),
      count: z.number(),
    },
    handler: async (input, _ctx) => {
      const raw = await listSnippets(input.site_id);
      const snippets = (raw ?? []).map((s: any) => ({
        id: s.id ?? 0,
        title: s.title ?? '',
        general: s.general ?? null,
        general_position: s.general_position ?? null,
        goal: s.goal ?? null,
        goal_position: s.goal_position ?? null,
      }));
      return {
        data: { snippets, count: snippets.length },
        summary: `Found ${snippets.length} snippet(s) for site ${input.site_id}.`,
      };
    },
  }, callerHash);
}
