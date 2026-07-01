import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { deleteForm } from '../../netlify/full-client.js';

export function registerNetlifyFormDelete(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'netlify_form_delete',
    category: 'write_orchestrated',
    annotations: {
      title: 'Netlify: delete form',
      description: 'Delete a Netlify form and all its submissions (DELETE /forms/{form_id}). IRREVERSIBLE. Defaults to dry_run.',
      readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true,
    },
    inputShape: {
      form_id: z.string().min(1).describe('Netlify form ID to delete.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      form_id: z.string().optional(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, form_id: input.form_id },
          audit: { before: null, after: input },
          summary: `DRY RUN: would DELETE form ${input.form_id} and all submissions. Pass dry_run=false to apply.`,
        };
      }
      await deleteForm(input.form_id);
      return {
        data: { executed: true, dry_run: false, form_id: input.form_id },
        audit: { before: { form_id: input.form_id }, after: null },
        summary: `Deleted form ${input.form_id}.`,
      };
    },
  }, callerHash);
}
