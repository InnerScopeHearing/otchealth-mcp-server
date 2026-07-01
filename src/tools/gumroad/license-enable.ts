import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { enableLicense } from '../../gumroad/full-client.js';

export function registerGumroadLicenseEnable(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'gumroad_license_enable',
    category: 'write_simple',
    annotations: {
      title: 'Enable Gumroad license key',
      description: 'Re-enable a previously disabled Gumroad license key so the buyer can use it again. Defaults to dry_run.',
      readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      product_id: z.string().describe('Gumroad product ID.'),
      license_key: z.string().describe('License key to enable.'),
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
          summary: `DRY RUN: would enable license key for product ${input.product_id}. Pass dry_run=false to apply.`,
        };
      }
      const resp = await enableLicense({ product_id: input.product_id, license_key: input.license_key });
      return {
        data: { executed: true, dry_run: false, purchase: resp.purchase ?? undefined },
        audit: { before: null, after: input },
        summary: `Enabled license key for product ${input.product_id}.`,
      };
    },
  }, callerHash);
}
