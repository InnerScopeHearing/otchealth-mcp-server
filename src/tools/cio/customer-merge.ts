import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { mergeCustomers } from '../../customerio/full-client.js';

export function registerCioCustomerMerge(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'cio_customer_merge',
    category: 'write_orchestrated',
    annotations: {
      title: 'Merge two Customer.io customer profiles (Track API)',
      description: 'Merge a secondary customer profile into a primary profile via Track API POST /merge_customers. The secondary profile is deleted; all its attributes, events, and segment memberships move to the primary. Irreversible. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputShape: {
      primary_id_type: z.enum(['email', 'id', 'cio_id']).describe('Identifier type for the primary (surviving) customer profile.'),
      primary_id: z.string().min(1).describe('Identifier value for the primary customer.'),
      secondary_id_type: z.enum(['email', 'id', 'cio_id']).describe('Identifier type for the secondary (deleted) customer profile.'),
      secondary_id: z.string().min(1).describe('Identifier value for the secondary customer — this profile will be deleted after the merge.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      primary_id: z.string(),
      secondary_id: z.string(),
      result: z.unknown().nullable(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, primary_id: input.primary_id, secondary_id: input.secondary_id, result: null },
          audit: { before: null, after: input },
          summary: `DRY RUN: would merge customer "${input.secondary_id}" (${input.secondary_id_type}) into "${input.primary_id}" (${input.primary_id_type}). The secondary profile will be permanently deleted. Pass dry_run=false to confirm.`,
        };
      }
      const result = await mergeCustomers({
        primary_id_type: input.primary_id_type,
        primary_id: input.primary_id,
        secondary_id_type: input.secondary_id_type,
        secondary_id: input.secondary_id,
        correlationId: ctx.correlationId,
      });
      return {
        data: { executed: true, dry_run: false, primary_id: input.primary_id, secondary_id: input.secondary_id, result },
        audit: { before: { secondary_id: input.secondary_id }, after: { primary_id: input.primary_id } },
        summary: `Customers merged: "${input.secondary_id}" absorbed into "${input.primary_id}". Secondary profile deleted.`,
      };
    },
  }, callerHash);
}
