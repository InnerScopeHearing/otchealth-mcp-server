import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { rotateLicense } from '../../gumroad/full-client.js';

export function registerGumroadLicenseRotate(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'gumroad_license_rotate',
    category: 'write_orchestrated',
    annotations: {
      title: 'Rotate Gumroad license key',
      description: 'Regenerate (rotate) a Gumroad license key, invalidating the old key. Use for compromised keys. Defaults to dry_run.',
      readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true,
    },
    inputShape: {
      product_id: z.string().describe('Gumroad product ID.'),
      license_key: z.string().describe('Existing license key to rotate/regenerate.'),
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
          summary: `DRY RUN: would rotate license key for product ${input.product_id} (old key invalidated). Pass dry_run=false to apply.`,
        };
      }
      const resp = await rotateLicense({ product_id: input.product_id, license_key: input.license_key });
      return {
        data: { executed: true, dry_run: false, purchase: resp.purchase ?? undefined },
        audit: { before: null, after: input },
        summary: `Rotated license key for product ${input.product_id}. Old key is now invalid.`,
      };
    },
  }, callerHash);
}
