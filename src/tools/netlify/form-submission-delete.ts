import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { deleteFormSubmission } from '../../netlify/full-client.js';

export function registerNetlifyFormSubmissionDelete(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'netlify_form_submission_delete',
    category: 'write_orchestrated',
    annotations: {
      title: 'Netlify: delete form submission',
      description: 'Delete a single form submission by ID (DELETE /submissions/{id}). Irreversible. Defaults to dry_run.',
      readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true,
    },
    inputShape: {
      submission_id: z.string().min(1).describe('Form submission ID to delete.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      submission_id: z.string().optional(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, submission_id: input.submission_id },
          audit: { before: null, after: input },
          summary: `DRY RUN: would delete form submission ${input.submission_id}. Pass dry_run=false to apply.`,
        };
      }
      await deleteFormSubmission(input.submission_id);
      return {
        data: { executed: true, dry_run: false, submission_id: input.submission_id },
        audit: { before: { submission_id: input.submission_id }, after: null },
        summary: `Deleted form submission ${input.submission_id}.`,
      };
    },
  }, callerHash);
}
