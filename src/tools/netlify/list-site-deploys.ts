import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { listSiteDeploys } from '../../netlify/api-client.js';

export function registerNetlifyListSiteDeploys(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'netlify_list_site_deploys',
    category: 'read',
    annotations: {
      title: 'List Netlify site deploys',
      description: 'List recent deploys for a Netlify site (state, branch, commit, created/published time, error message). Use to check whether the last deploy of the INND site or any portfolio site succeeded.',
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      site_id: z.string().min(1).describe('The Netlify site id (from netlify_list_sites).'),
      per_page: z.number().int().min(1).max(50).optional().describe('Number of recent deploys to return (max 50).'),
    },
    outputShape: {
      deploys: z.array(z.object({
        id: z.string(),
        state: z.string(),
        branch: z.string().nullable(),
        commit_ref: z.string().nullable(),
        created_at: z.string().nullable(),
        published_at: z.string().nullable(),
        error_message: z.string().nullable(),
      })),
      count: z.number(),
    },
    handler: async (input, _ctx) => {
      const deploys = await listSiteDeploys(input.site_id, { per_page: input.per_page });
      const mapped = (deploys ?? []).map((d: any) => ({
        id: d.id,
        state: d.state ?? 'unknown',
        branch: d.branch ?? null,
        commit_ref: d.commit_ref ?? null,
        created_at: d.created_at ?? null,
        published_at: d.published_at ?? null,
        error_message: d.error_message ?? null,
      }));
      const latest = mapped[0];
      return {
        data: { deploys: mapped, count: mapped.length },
        summary: latest
          ? `Latest deploy ${latest.id} is "${latest.state}"${latest.error_message ? ` (error: ${latest.error_message})` : ''}.`
          : 'No deploys found for this site.',
      };
    },
  }, callerHash);
}
