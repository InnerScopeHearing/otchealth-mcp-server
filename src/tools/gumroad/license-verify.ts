import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { verifyLicense } from '../../gumroad/full-client.js';

export function registerGumroadLicenseVerify(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'gumroad_license_verify',
    category: 'write_simple',
    annotations: {
      title: 'Verify Gumroad license key',
      description: 'Verify whether a Gumroad license key is valid and active. Optionally increments the use count (e.g. on app activation). Defaults to dry_run.',
      readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true,
    },
    inputShape: {
      product_id: z.string().describe('Gumroad product ID the license key belongs to.'),
      license_key: z.string().describe('License key to verify (case-insensitive).'),
      increment_uses_count: z.boolean().optional().default(true).describe('If true (default), increment the license use count on successful verification.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      success: z.boolean().optional(),
      purchase: z.record(z.unknown()).optional(),
      uses: z.number().optional(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true },
          audit: { before: null, after: input },
          summary: `DRY RUN: would verify license key for product ${input.product_id}. Pass dry_run=false to apply.`,
        };
      }
      const resp = await verifyLicense({
        product_id: input.product_id,
        license_key: input.license_key,
        increment_uses_count: input.increment_uses_count,
      });
      return {
        data: { executed: true, dry_run: false, success: resp.success, purchase: resp.purchase ?? undefined, uses: resp.uses },
        audit: { before: null, after: input },
        summary: `License verification: ${resp.success ? 'valid' : 'invalid'}. Uses: ${resp.uses ?? 'unknown'}.`,
      };
    },
  }, callerHash);
}
