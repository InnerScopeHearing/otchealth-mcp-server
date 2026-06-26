import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { listFormSubmissions } from '../../netlify/full-client.js';

export function registerNetlifyFormSubmissionList(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'netlify_form_submission_list',
    category: 'read',
    annotations: {
      title: 'Netlify: list form submissions',
      description: 'List submissions for a Netlify form (GET /forms/{form_id}/submissions) with pagination and date filters.',
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      form_id: z.string().min(1).describe('Netlify form ID.'),
      per_page: z.number().int().min(1).max(100).optional().describe('Results per page (max 100).'),
      page: z.number().int().min(1).optional().describe('Page number.'),
      after: z.string().optional().describe('Return submissions after this ISO timestamp.'),
      before: z.string().optional().describe('Return submissions before this ISO timestamp.'),
    },
    outputShape: {
      submissions: z.array(z.object({
        id: z.string(),
        created_at: z.string().nullable(),
        number: z.number().nullable(),
        email: z.string().nullable(),
        name: z.string().nullable(),
        body: z.record(z.unknown()),
      })),
      count: z.number(),
    },
    handler: async (input, _ctx) => {
      const { form_id, ...opts } = input;
      const raw = await listFormSubmissions(form_id, opts);
      const submissions = (raw ?? []).map((s: any) => ({
        id: s.id ?? '',
        created_at: s.created_at ?? null,
        number: s.number ?? null,
        email: s.email ?? null,
        name: s.name ?? null,
        body: s.body ?? s.data ?? {},
      }));
      return {
        data: { submissions, count: submissions.length },
        summary: `Found ${submissions.length} submission(s) for form ${form_id}.`,
      };
    },
  }, callerHash);
}
