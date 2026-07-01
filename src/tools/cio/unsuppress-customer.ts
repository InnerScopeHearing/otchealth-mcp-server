import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { unsuppressCustomer } from '../../customerio/write-client.js';

export function registerUnsuppressCustomer(
  server: McpServer,
  callerHash: CallerHashProvider,
): void {
  registerTool(
    server,
    {
      name: 'cio_unsuppress_customer',
      category: 'write_simple',
      annotations: {
        title: 'Unsuppress Customer.io customer (Track API)',
        description:
          'Removes suppression from a customer in Customer.io via Track API POST /customers/{id}/unsuppress. ' +
          'This restores the customer\'s eligibility to receive messages. ' +
          'Only use after confirming re-consent where required by applicable law (CAN-SPAM, GDPR, CCPA). ' +
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
            'Customer identifier to unsuppress: email address, workspace customer id, or cio_id.',
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
              `DRY RUN: would unsuppress customer "${input.identifier}", restoring message eligibility. ` +
              'Confirm re-consent before applying. Pass dry_run=false to apply.',
          };
        }

        const upstream = await unsuppressCustomer({
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
          summary: `Customer "${input.identifier}" unsuppressed in Customer.io.`,
        };
      },
    },
    callerHash,
  );
}
