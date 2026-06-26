import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { setSubscriberAttributes } from '../../revenuecat/write-client.js';

export function registerRevenueCatSetSubscriberAttributes(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'revenuecat_set_subscriber_attributes',
    category: 'write_simple',
    annotations: {
      title: 'Set RevenueCat subscriber attributes',
      description:
        'Set one or more custom key/value attributes on a RevenueCat subscriber via POST /v1/subscribers/{app_user_id}/attributes. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      app_user_id: z
        .string()
        .min(1)
        .describe('RevenueCat app user ID (alias or canonical).'),
      attributes: z
        .record(
          z.object({
            value: z.string().describe('Attribute value (pass empty string to delete the attribute).'),
            updated_at_ms: z
              .number()
              .optional()
              .describe('Unix timestamp in milliseconds. Defaults to server time if omitted.'),
          }),
        )
        .refine((obj) => Object.keys(obj).length > 0, 'attributes must not be empty')
        .describe('Map of attribute key -> { value, updated_at_ms? }. Pass value="" to delete an attribute.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      app_user_id: z.string(),
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
            app_user_id: input.app_user_id,
            attribute_keys,
            upstream_response: null,
          },
          audit: { before: null, after: input.attributes },
          summary: `DRY RUN: would set ${attribute_keys.length} attribute(s) on subscriber "${input.app_user_id}". Pass dry_run=false to apply.`,
        };
      }
      const upstream = await setSubscriberAttributes({
        app_user_id: input.app_user_id,
        attributes: input.attributes,
      });
      return {
        data: {
          executed: true,
          dry_run: false,
          app_user_id: input.app_user_id,
          attribute_keys,
          upstream_response: upstream,
        },
        audit: { before: null, after: input.attributes },
        summary: `Set ${attribute_keys.length} attribute(s) on RevenueCat subscriber "${input.app_user_id}".`,
      };
    },
  }, callerHash);
}
