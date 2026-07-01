import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { deleteDnsRecord } from '../../cloudflare/write-client.js';

export function registerCloudflareDeleteDnsRecord(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'cloudflare_delete_dns_record',
    category: 'write_orchestrated',
    annotations: {
      title: 'Delete DNS record',
      description:
        'Permanently delete a DNS record from the zone. This action is irreversible — use cloudflare_list_dns_records first to confirm the record ID. ' +
        'CTO-gated: DNS changes are high-risk infrastructure. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputShape: {
      record_id: z.string().min(1).describe('The DNS record ID to delete (from cloudflare_list_dns_records). Confirm the record exists before deleting.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      record_id: z.string(),
      upstream_result: z.unknown().nullable(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: {
            executed: false,
            dry_run: true,
            record_id: input.record_id,
            upstream_result: null,
          },
          audit: { before: null, after: input },
          summary: `DRY RUN: would permanently DELETE DNS record ${input.record_id}. Pass dry_run=false to apply. THIS IS IRREVERSIBLE.`,
        };
      }

      const upstream = await deleteDnsRecord(input.record_id);

      return {
        data: {
          executed: true,
          dry_run: false,
          record_id: input.record_id,
          upstream_result: upstream?.result ?? upstream,
        },
        audit: { before: null, after: { record_id: input.record_id } },
        summary: `Deleted DNS record ${input.record_id}.`,
      };
    },
  }, callerHash);
}
