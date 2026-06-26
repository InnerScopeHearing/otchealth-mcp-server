import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { listDnsRecords } from '../../netlify/full-client.js';

export function registerNetlifyDnsRecordList(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'netlify_dns_record_list',
    category: 'read',
    annotations: {
      title: 'Netlify: list DNS records in a zone',
      description: 'List all DNS records in a Netlify-managed zone (GET /dns_zones/{zone_id}/dns_records).',
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      zone_id: z.string().min(1).describe('DNS zone ID. Use netlify_dns_zone_list to find it.'),
    },
    outputShape: {
      records: z.array(z.object({
        id: z.string(),
        type: z.string(),
        hostname: z.string(),
        value: z.string(),
        ttl: z.number().nullable(),
        priority: z.number().nullable(),
        managed: z.boolean().nullable(),
      })),
      count: z.number(),
    },
    handler: async (input, _ctx) => {
      const raw = await listDnsRecords(input.zone_id);
      const records = (raw ?? []).map((r: any) => ({
        id: r.id ?? '',
        type: r.type ?? '',
        hostname: r.hostname ?? '',
        value: r.value ?? '',
        ttl: r.ttl ?? null,
        priority: r.priority ?? null,
        managed: r.managed ?? null,
      }));
      return {
        data: { records, count: records.length },
        summary: `Found ${records.length} DNS record(s) in zone ${input.zone_id}.`,
      };
    },
  }, callerHash);
}
