import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { createOrUpdateCustomer } from '../../customerio/write-client.js';

export function registerCreateOrUpdateCustomer(
  server: McpServer,
  callerHash: CallerHashProvider,
): void {
  registerTool(
    server,
    {
      name: 'cio_create_or_update_customer',
      category: 'write_simple',
      annotations: {
        title: 'Create or update Customer.io customer profile (Track API)',
        description:
          'Creates or updates a customer profile in Customer.io via Track API PUT /customers/{id}. ' +
          'If the identifier does not exist it is created; if it exists the supplied attributes are merged. ' +
          'Identifiers containing "medreview" are blocked (PHI ring-safety). Defaults to dry_run.',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputShape: {
        identifier: z
          .string()
          .min(1)
          .describe(
            'Customer identifier: email address, workspace customer id, or cio_id. Must be URL-safe or will be encoded.',
          ),
        attributes: z
          .record(z.unknown())
          .optional()
          .describe(
            'Key/value attributes to set on the profile. Omit to simply create an empty profile. ' +
            'Reserved CIO internal keys (cio_id, unsubscribed, etc.) should not be set here.',
          ),
      },
      outputShape: {
        executed: z.boolean(),
        dry_run: z.boolean(),
        identifier: z.string(),
        attribute_count: z.number(),
        upstream_response: z.unknown().nullable(),
      },
      handler: async (input, ctx) => {
        const attribute_count = Object.keys(input.attributes ?? {}).length;

        if (ctx.dryRun) {
          return {
            data: {
              executed: false,
              dry_run: true,
              identifier: input.identifier,
              attribute_count,
              upstream_response: null,
            },
            audit: { before: null, after: input },
            summary: `DRY RUN: would create/update customer "${input.identifier}" with ${attribute_count} attribute(s). Pass dry_run=false to apply.`,
          };
        }

        const upstream = await createOrUpdateCustomer({
          identifier: input.identifier,
          attributes: input.attributes,
          correlationId: ctx.correlationId,
        });

        return {
          data: {
            executed: true,
            dry_run: false,
            identifier: input.identifier,
            attribute_count,
            upstream_response: upstream,
          },
          audit: { before: null, after: input },
        };
      },
    },
    callerHash,
  );
}
