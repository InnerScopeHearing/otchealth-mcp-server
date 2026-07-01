import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { disableLicense } from '../../gumroad/full-client.js';

export function registerGumroadLicenseDisable(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'gumroad_license_disable',
    category: 'write_simple',
    annotations: {
      title: 'Disable Gumroad license key',
      description: 'Disable a Gumroad license key so it can no longer be used by the buyer (e.g. on fraud or chargeback). Defaults to dry_run.',
      readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      product_id: z.string().describe('Gumroad product ID.'),
      license_key: z.string().describe('License key to disable.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      purchase: z.record(z.unknown()).optional(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true },
          audit: { before: null, after: input },
          summary: `DRY RUN: would disable license key for product ${input.product_id}. Pass dry_run=false to apply.`,
        };
      }
      const resp = await disableLicense({ product_id: input.product_id, license_key: input.license_key });
      return {
        data: { executed: true, dry_run: false, purchase: resp.purchase ?? undefined },
        audit: { before: null, after: input },
        summary: `Disabled license key for product ${input.product_id}.`,
      };
    },
  }, callerHash);
}
