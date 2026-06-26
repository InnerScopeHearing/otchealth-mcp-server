import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { voidCreditNote } from '../../stripe/full-client.js';

export function registerStripeCreditNoteVoid(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'stripe_credit_note_void',
    category: 'write_orchestrated',
    annotations: {
      title: 'Void Stripe credit note',
      description: 'Void a credit note. Irreversible. Defaults to dry_run.',
      readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true,
    },
    inputShape: {
      credit_note_id: z.string().describe('Credit note ID (cn_...) to void.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      credit_note_id: z.string().nullable(),
      status: z.string().nullable(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, credit_note_id: input.credit_note_id, status: null },
          audit: { before: null, after: input },
          summary: `DRY RUN: would void credit note ${input.credit_note_id}. This is irreversible. Pass dry_run=false to apply.`,
        };
      }
      const upstream = await voidCreditNote(input.credit_note_id);
      return {
        data: { executed: true, dry_run: false, credit_note_id: upstream.id, status: upstream.status },
        audit: { before: null, after: input },
        summary: `Voided credit note ${upstream.id}.`,
      };
    },
  }, callerHash);
}
