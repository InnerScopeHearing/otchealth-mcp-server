import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { getForm } from '../../netlify/full-client.js';

export function registerNetlifyFormGet(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'netlify_form_get',
    category: 'read',
    annotations: {
      title: 'Netlify: get form details',
      description: 'Fetch details for a single Netlify form by ID (GET /forms/{form_id}). Returns field names and submission count.',
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      form_id: z.string().min(1).describe('Netlify form ID.'),
    },
    outputShape: {
      id: z.string(),
      name: z.string(),
      site_id: z.string().nullable(),
      fields: z.array(z.unknown()),
      submission_count: z.number().nullable(),
      created_at: z.string().nullable(),
    },
    handler: async (input, _ctx) => {
      const f = await getForm(input.form_id);
      return {
        data: {
          id: f.id ?? '',
          name: f.name ?? '',
          site_id: f.site_id ?? null,
          fields: f.fields ?? [],
          submission_count: f.submission_count ?? null,
          created_at: f.created_at ?? null,
        },
        summary: `Form "${f.name}" (${f.id}) — ${f.submission_count ?? 0} submission(s).`,
      };
    },
  }, callerHash);
}
