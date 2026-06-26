import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { updateDnssec } from '../../cloudflare/full-client.js';

export function registerCloudflareDnssecUpdate(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'cloudflare_dnssec_update',
    category: 'write_orchestrated',
    annotations: {
      title: 'Update DNSSEC status',
      description: 'Enable or disable DNSSEC for a zone. Disabling DNSSEC removes signing and may break resolution for resolvers that validate signatures. Defaults to dry_run.',
      readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      status: z.enum(['active', 'disabled']).describe('"active" to enable DNSSEC, "disabled" to turn off signing.'),
      zone_id: z.string().optional().describe('Zone ID (defaults to CLOUDFLARE_ZONE_ID env var).'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      dnssec: z.unknown(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, dnssec: null },
          audit: { before: null, after: { status: input.status } },
          summary: `DRY RUN: would set DNSSEC status to "${input.status}". Pass dry_run=false to apply.`,
        };
      }
      const dnssec = await updateDnssec(input.status, input.zone_id);
      return {
        data: { executed: true, dry_run: false, dnssec },
        audit: { before: null, after: { status: input.status } },
        summary: `DNSSEC status set to "${input.status}".`,
      };
    },
  }, callerHash);
}
