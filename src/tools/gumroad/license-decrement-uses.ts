import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { decrementLicenseUsesCount } from '../../gumroad/full-client.js';

export function registerGumroadLicenseDecrementUses(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'gumroad_license_decrement_uses',
    category: 'write_simple',
    annotations: {
      title: 'Decrement Gumroad license use count',
      description: 'Decrement the use count of a Gumroad license key by one (e.g. on app uninstall/deactivation). Defaults to dry_run.',
      readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true,
    },
    inputShape: {
      product_id: z.string().describe('Gumroad product ID.'),
      license_key: z.string().describe('License key whose use count to decrement.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      uses: z.number().optional(),
      purchase: z.record(z.unknown()).optional(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true },
          audit: { before: null, after: input },
          summary: `DRY RUN: would decrement use count for license key of product ${input.product_id}. Pass dry_run=false to apply.`,
        };
      }
      const resp = await decrementLicenseUsesCount({ product_id: input.product_id, license_key: input.license_key });
      return {
        data: { executed: true, dry_run: false, uses: resp.uses, purchase: resp.purchase ?? undefined },
        audit: { before: null, after: input },
        summary: `Decremented license use count for product ${input.product_id}. Uses now: ${resp.uses ?? 'unknown'}.`,
      };
    },
  }, callerHash);
}
