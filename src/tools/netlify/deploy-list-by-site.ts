import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { listSiteDeploysFull } from '../../netlify/full-client.js';

export function registerNetlifyDeployListBySite(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'netlify_deploy_list_by_site',
    category: 'read',
    annotations: {
      title: 'Netlify: list deploys for a site (with filters)',
      description: 'List deploys for a Netlify site with optional branch/state filters and pagination (GET /sites/{site_id}/deploys).',
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      site_id: z.string().min(1).describe('Netlify site ID.'),
      branch: z.string().optional().describe('Filter deploys by branch name.'),
      state: z.string().optional().describe('Filter by deploy state: building, ready, error, processing, uploading, uploaded, cancelled.'),
      per_page: z.number().int().min(1).max(100).optional().describe('Results per page (max 100).'),
      page: z.number().int().min(1).optional().describe('Page number.'),
    },
    outputShape: {
      deploys: z.array(z.object({
        id: z.string(),
        state: z.string().nullable(),
        branch: z.string().nullable(),
        commit_ref: z.string().nullable(),
        deploy_url: z.string().nullable(),
        created_at: z.string().nullable(),
        error_message: z.string().nullable(),
      })),
      count: z.number(),
    },
    handler: async (input, _ctx) => {
      const { site_id, ...opts } = input;
      const raw = await listSiteDeploysFull(site_id, opts);
      const deploys = (raw ?? []).map((d: any) => ({
        id: d.id ?? '',
        state: d.state ?? null,
        branch: d.branch ?? null,
        commit_ref: d.commit_ref ?? null,
        deploy_url: d.deploy_url ?? d.links?.permalink ?? null,
        created_at: d.created_at ?? null,
        error_message: d.error_message ?? null,
      }));
      return {
        data: { deploys, count: deploys.length },
        summary: `Found ${deploys.length} deploy(s) for site ${site_id}.`,
      };
    },
  }, callerHash);
}
