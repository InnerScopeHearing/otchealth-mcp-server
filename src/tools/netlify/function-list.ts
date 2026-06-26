import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { listSiteFunctions } from '../../netlify/full-client.js';

export function registerNetlifyFunctionList(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'netlify_function_list',
    category: 'read',
    annotations: {
      title: 'Netlify: list site functions',
      description: 'List serverless functions deployed for a site (GET /sites/{site_id}/functions). Returns function names, IDs, and runtime.',
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      site_id: z.string().min(1).describe('Netlify site ID.'),
    },
    outputShape: {
      functions: z.array(z.object({
        id: z.string(),
        name: z.string(),
        sha: z.string().nullable(),
        created_at: z.string().nullable(),
      })),
      count: z.number(),
    },
    handler: async (input, _ctx) => {
      const raw = await listSiteFunctions(input.site_id);
      const functions = (raw ?? []).map((f: any) => ({
        id: f.id ?? '',
        name: f.name ?? '',
        sha: f.sha ?? null,
        created_at: f.created_at ?? null,
      }));
      return {
        data: { functions, count: functions.length },
        summary: `Found ${functions.length} function(s) for site ${input.site_id}.`,
      };
    },
  }, callerHash);
}
