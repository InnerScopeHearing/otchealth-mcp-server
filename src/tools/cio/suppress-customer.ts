import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { suppressCustomer } from '../../customerio/write-client.js';

export function registerSuppressCustomer(
  server: McpServer,
  callerHash: CallerHashProvider,
): void {
  registerTool(
    server,
    {
      name: 'cio_suppress_customer',
      category: 'write_simple',
      annotations: {
        title: 'Suppress Customer.io customer (Track API)',
        description:
          'Suppresses a customer in Customer.io via Track API POST /customers/{id}/suppress. ' +
          'Suppressed customers will no longer receive any messages from any campaign or broadcast. ' +
          'Use for opt-outs, GDPR/CCPA requests, or hard bounces. ' +
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
            'Customer identifier to suppress: email address, workspace customer id, or cio_id.',
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
              `DRY RUN: would suppress customer "${input.identifier}" — they would stop receiving all messages. ` +
              'Pass dry_run=false to apply.',
          };
        }

        const upstream = await suppressCustomer({
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
          summary: `Customer "${input.identifier}" suppressed in Customer.io.`,
        };
      },
    },
    callerHash,
  );
}
