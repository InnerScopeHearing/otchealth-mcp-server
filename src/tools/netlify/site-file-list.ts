import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { listSiteFiles } from '../../netlify/full-client.js';

export function registerNetlifySiteFileList(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'netlify_site_file_list',
    category: 'read',
    annotations: {
      title: 'Netlify: list site files',
      description: 'List files in the most recent production deploy of a site (GET /sites/{site_id}/files). Returns paths and SHAs.',
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      site_id: z.string().min(1).describe('Netlify site ID.'),
    },
    outputShape: {
      files: z.array(z.object({
        id: z.string(),
        path: z.string(),
        sha: z.string().nullable(),
        size: z.number().nullable(),
        mime_type: z.string().nullable(),
      })),
      count: z.number(),
    },
    handler: async (input, _ctx) => {
      const raw = await listSiteFiles(input.site_id);
      const files = (raw ?? []).map((f: any) => ({
        id: f.id ?? f.path ?? '',
        path: f.path ?? '',
        sha: f.sha ?? null,
        size: f.size ?? null,
        mime_type: f.mime_type ?? null,
      }));
      return {
        data: { files, count: files.length },
        summary: `Found ${files.length} file(s) in site ${input.site_id}.`,
      };
    },
  }, callerHash);
}
