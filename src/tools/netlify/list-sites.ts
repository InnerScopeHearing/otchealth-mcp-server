import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { listSites } from '../../netlify/api-client.js';

export function registerNetlifyListSites(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'netlify_list_sites',
    category: 'read',
    annotations: {
      title: 'List Netlify sites',
      description: 'List Netlify sites for the account (id, name, url, custom domain, last published time). Use to find the INND site or any portfolio deploy target.',
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      name: z.string().optional().describe('Filter by site name (substring match on Netlify side).'),
      per_page: z.number().int().min(1).max(100).optional().describe('Results per page (max 100).'),
    },
    outputShape: {
      sites: z.array(z.object({
        id: z.string(),
        name: z.string(),
        url: z.string(),
        custom_domain: z.string().nullable(),
        ssl_url: z.string().nullable(),
        published_at: z.string().nullable(),
        state: z.string().nullable(),
      })),
      count: z.number(),
    },
    handler: async (input, _ctx) => {
      const sites = await listSites(input);
      const mapped = (sites ?? []).map((s: any) => ({
        id: s.id,
        name: s.name,
        url: s.url ?? s.ssl_url ?? '',
        custom_domain: s.custom_domain ?? null,
        ssl_url: s.ssl_url ?? null,
        published_at: s.published_deploy?.published_at ?? null,
        state: s.state ?? null,
      }));
      return {
        data: { sites: mapped, count: mapped.length },
        summary: `Found ${mapped.length} Netlify site(s).`,
      };
    },
  }, callerHash);
}
