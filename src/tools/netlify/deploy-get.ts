import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { getDeploy } from '../../netlify/full-client.js';

export function registerNetlifyDeployGet(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'netlify_deploy_get',
    category: 'read',
    annotations: {
      title: 'Netlify: get deploy details',
      description: 'Fetch full details for a single deploy by ID (GET /deploys/{deploy_id}). Returns state, branch, sha, review URL, error message.',
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      deploy_id: z.string().min(1).describe('Netlify deploy ID.'),
    },
    outputShape: {
      id: z.string(),
      site_id: z.string().nullable(),
      state: z.string().nullable(),
      branch: z.string().nullable(),
      commit_ref: z.string().nullable(),
      deploy_url: z.string().nullable(),
      created_at: z.string().nullable(),
      updated_at: z.string().nullable(),
      error_message: z.string().nullable(),
      locked: z.boolean().nullable(),
    },
    handler: async (input, _ctx) => {
      const d = await getDeploy(input.deploy_id);
      return {
        data: {
          id: d.id ?? '',
          site_id: d.site_id ?? null,
          state: d.state ?? null,
          branch: d.branch ?? null,
          commit_ref: d.commit_ref ?? null,
          deploy_url: d.deploy_url ?? d.links?.permalink ?? null,
          created_at: d.created_at ?? null,
          updated_at: d.updated_at ?? null,
          error_message: d.error_message ?? null,
          locked: d.locked ?? null,
        },
        summary: `Deploy ${d.id}: state=${d.state ?? 'unknown'}, branch=${d.branch ?? 'unknown'}.`,
      };
    },
  }, callerHash);
}
