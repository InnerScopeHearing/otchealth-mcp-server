import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { deleteCustomer } from '../../customerio/write-client.js';

export function registerDeleteCustomer(
  server: McpServer,
  callerHash: CallerHashProvider,
): void {
  registerTool(
    server,
    {
      name: 'cio_delete_customer',
      category: 'write_simple',
      annotations: {
        title: 'Delete Customer.io customer profile (Track API)',
        description:
          'Permanently deletes a customer profile from Customer.io via Track API DELETE /customers/{id}. ' +
          'This is irreversible — the customer and all associated data (events, attributes) are removed from the workspace. ' +
          'Identifiers containing "medreview" are blocked (PHI ring-safety). Defaults to dry_run.',
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
      inputShape: {
        identifier: z
          .string()
          .min(1)
          .describe(
            'Customer identifier to delete: email address, workspace customer id, or cio_id.',
          ),
      },
      outputShape: {
        executed: z.boolean(),
        dry_run: z.boolean(),
        identifier: z.string(),
        upstream_response: z.unknown().nullable(),
      },
      handler: async (input, ctx) => {
        if (ctx.dryRun) {
          return {
            data: {
              executed: false,
              dry_run: true,
              identifier: input.identifier,
              upstream_response: null,
            },
            audit: { before: null, after: input },
            summary:
              `DRY RUN: would PERMANENTLY DELETE customer "${input.identifier}". This is irreversible. ` +
              'Pass dry_run=false to apply.',
          };
        }

        const upstream = await deleteCustomer({
          identifier: input.identifier,
          correlationId: ctx.correlationId,
        });

        return {
          data: {
            executed: true,
            dry_run: false,
            identifier: input.identifier,
            upstream_response: upstream,
          },
          audit: { before: null, after: input },
          summary: `Customer "${input.identifier}" permanently deleted from Customer.io.`,
        };
      },
    },
    callerHash,
  );
}
