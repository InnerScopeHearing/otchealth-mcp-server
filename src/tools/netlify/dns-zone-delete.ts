import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { deleteDnsZone } from '../../netlify/full-client.js';

export function registerNetlifyDnsZoneDelete(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'netlify_dns_zone_delete',
    category: 'write_orchestrated',
    annotations: {
      title: 'Netlify: delete DNS zone',
      description: 'Delete a Netlify-managed DNS zone and all its records (DELETE /dns_zones/{zone_id}). IRREVERSIBLE. Disrupts live DNS. Defaults to dry_run.',
      readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true,
    },
    inputShape: {
      zone_id: z.string().min(1).describe('DNS zone ID to delete. Use netlify_dns_zone_list to confirm.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      zone_id: z.string().optional(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, zone_id: input.zone_id },
          audit: { before: null, after: input },
          summary: `DRY RUN: would DELETE DNS zone ${input.zone_id} and ALL its records. Pass dry_run=false to apply.`,
        };
      }
      await deleteDnsZone(input.zone_id);
      return {
        data: { executed: true, dry_run: false, zone_id: input.zone_id },
        audit: { before: { zone_id: input.zone_id }, after: null },
        summary: `Deleted DNS zone ${input.zone_id}.`,
      };
    },
  }, callerHash);
}
