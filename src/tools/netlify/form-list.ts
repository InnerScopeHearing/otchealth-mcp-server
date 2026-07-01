import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { listForms } from '../../netlify/full-client.js';

export function registerNetlifyFormList(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'netlify_form_list',
    category: 'read',
    annotations: {
      title: 'Netlify: list forms',
      description: 'List Netlify forms. If site_id is provided, scopes to that site (GET /sites/{site_id}/forms). Otherwise lists all forms (GET /forms).',
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      site_id: z.string().optional().describe('Scope to a specific site ID.'),
    },
    outputShape: {
      forms: z.array(z.object({
        id: z.string(),
        name: z.string(),
        site_id: z.string().nullable(),
        submission_count: z.number().nullable(),
        created_at: z.string().nullable(),
      })),
      count: z.number(),
    },
    handler: async (input, _ctx) => {
      const raw = await listForms(input.site_id);
      const forms = (raw ?? []).map((f: any) => ({
        id: f.id ?? '',
        name: f.name ?? '',
        site_id: f.site_id ?? null,
        submission_count: f.submission_count ?? null,
        created_at: f.created_at ?? null,
      }));
      return {
        data: { forms, count: forms.length },
        summary: `Found ${forms.length} form(s)${input.site_id ? ` for site ${input.site_id}` : ''}.`,
      };
    },
  }, callerHash);
}
