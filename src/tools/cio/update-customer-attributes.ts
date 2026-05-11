import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { identifyCustomer } from '../../customerio/track-api-client.js';

/**
 * Attribute keys reserved by Customer.io or used by other automated systems.
 * Reject writes to these to keep the connector from accidentally clobbering
 * critical fields (cio_id, email, segment-membership-affecting attributes).
 */
const PROTECTED_ATTRS = new Set([
  'cio_id',
  'id',
  'email',
  'created_at',
  'unsubscribed',
  'unsubscribed_at',
]);

export function registerUpdateCustomerAttributes(
  server: McpServer,
  callerHash: CallerHashProvider,
): void {
  registerTool(
    server,
    {
      name: 'cio_update_customer_attributes',
      category: 'write_simple',
      annotations: {
        title: 'Update Customer.io customer attributes (Track API)',
        description:
          'Update one or more attributes on a Customer.io customer profile via Track API PUT /customers/{id}. Protected attribute names are rejected. Defaults to dry_run.',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputShape: {
        identifier: z
          .string()
          .min(1)
          .describe('Customer identifier (email, workspace id, or cio_id).'),
        attributes: z
          .record(z.unknown())
          .refine((obj) => Object.keys(obj).length > 0, 'attributes must not be empty')
          .refine(
            (obj) => !Object.keys(obj).some((k) => PROTECTED_ATTRS.has(k)),
            `attribute keys may not include any of: ${[...PROTECTED_ATTRS].join(', ')}`,
          ),
      },
      outputShape: {
        executed: z.boolean(),
        dry_run: z.boolean(),
        identifier: z.string(),
        attribute_keys: z.array(z.string()),
        upstream_response: z.unknown().nullable(),
      },
      handler: async (input, ctx) => {
        const attribute_keys = Object.keys(input.attributes);

        if (ctx.dryRun) {
          return {
            data: {
              executed: false,
              dry_run: true,
              identifier: input.identifier,
              attribute_keys,
              upstream_response: null,
            },
            audit: { before: null, after: input.attributes },
            summary: `DRY RUN: would update ${attribute_keys.length} attribute(s). Pass dry_run=false to apply.`,
          };
        }

        const upstream = await identifyCustomer({
          identifier: input.identifier,
          attributes: input.attributes,
          correlationId: ctx.correlationId,
        });

        return {
          data: {
            executed: true,
            dry_run: false,
            identifier: input.identifier,
            attribute_keys,
            upstream_response: upstream,
          },
          audit: { before: null, after: input.attributes },
        };
      },
    },
    callerHash,
  );
}
