import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { deleteDnsRecord } from '../../netlify/full-client.js';

export function registerNetlifyDnsRecordDelete(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'netlify_dns_record_delete',
    category: 'write_orchestrated',
    annotations: {
      title: 'Netlify: delete DNS record',
      description: 'Delete a single DNS record from a Netlify-managed zone (DELETE /dns_zones/{zone_id}/dns_records/{record_id}). Immediately removes the record. Defaults to dry_run.',
      readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true,
    },
    inputShape: {
      zone_id: z.string().min(1).describe('DNS zone ID.'),
      record_id: z.string().min(1).describe('DNS record ID to delete. Use netlify_dns_record_list to find it.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      record_id: z.string().optional(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, record_id: input.record_id },
          audit: { before: null, after: input },
          summary: `DRY RUN: would delete DNS record ${input.record_id} from zone ${input.zone_id}. Pass dry_run=false to apply.`,
        };
      }
      await deleteDnsRecord(input.zone_id, input.record_id);
      return {
        data: { executed: true, dry_run: false, record_id: input.record_id },
        audit: { before: { record_id: input.record_id }, after: null },
        summary: `Deleted DNS record ${input.record_id} from zone ${input.zone_id}.`,
      };
    },
  }, callerHash);
}
