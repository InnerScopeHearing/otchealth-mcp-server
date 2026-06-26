import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { updateDnsRecord } from '../../cloudflare/write-client.js';

export function registerCloudflareUpdateDnsRecord(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'cloudflare_update_dns_record',
    category: 'write_orchestrated',
    annotations: {
      title: 'Update DNS record',
      description:
        'Partially update an existing DNS record on the zone (PATCH). Only supplied fields are changed. ' +
        'CTO-gated: DNS changes are high-risk infrastructure. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      record_id: z.string().min(1).describe('The DNS record ID to update (from cloudflare_list_dns_records).'),
      type: z.string().optional().describe('New record type (A, AAAA, CNAME, MX, TXT, etc.) — omit to leave unchanged.'),
      name: z.string().optional().describe('New record name (e.g. "coo" or "@") — omit to leave unchanged.'),
      content: z.string().optional().describe('New record value (IP, hostname, text) — omit to leave unchanged.'),
      ttl: z.number().int().optional().describe('TTL in seconds (1 = auto) — omit to leave unchanged.'),
      proxied: z.boolean().optional().describe('Whether to proxy through Cloudflare — omit to leave unchanged.'),
      priority: z.number().int().optional().describe('Priority for MX records — omit to leave unchanged.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      record_id: z.string(),
      updated_fields: z.array(z.string()),
      upstream_result: z.unknown().nullable(),
    },
    handler: async (input, ctx) => {
      const updatedFields = (['type', 'name', 'content', 'ttl', 'proxied', 'priority'] as const)
        .filter((k) => input[k] !== undefined);

      if (ctx.dryRun) {
        return {
          data: {
            executed: false,
            dry_run: true,
            record_id: input.record_id,
            updated_fields: updatedFields,
            upstream_result: null,
          },
          audit: { before: null, after: input },
          summary: `DRY RUN: would PATCH DNS record ${input.record_id} — fields: ${updatedFields.join(', ') || '(none)'}. Pass dry_run=false to apply.`,
        };
      }

      const upstream = await updateDnsRecord({
        recordId: input.record_id,
        type: input.type,
        name: input.name,
        content: input.content,
        ttl: input.ttl,
        proxied: input.proxied,
        priority: input.priority,
      });

      return {
        data: {
          executed: true,
          dry_run: false,
          record_id: input.record_id,
          updated_fields: updatedFields,
          upstream_result: upstream?.result ?? upstream,
        },
        audit: { before: null, after: input },
        summary: `Updated DNS record ${input.record_id} — fields changed: ${updatedFields.join(', ')}.`,
      };
    },
  }, callerHash);
}
