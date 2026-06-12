import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { listDnsRecords } from '../../cloudflare/api-client.js';

export function registerCloudflareListDnsRecords(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'cloudflare_list_dns_records',
    category: 'read',
    annotations: {
      title: 'List DNS records',
      description: 'List DNS records for the zone, optionally filtered by type or name.',
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      type: z.string().optional().describe('Filter by record type (A, AAAA, CNAME, MX, TXT, etc.).'),
      name: z.string().optional().describe('Filter by record name.'),
      per_page: z.number().int().min(1).max(100).optional().describe('Results per page (max 100).'),
    },
    outputShape: {
      records: z.array(z.object({
        id: z.string(),
        type: z.string(),
        name: z.string(),
        content: z.string(),
        ttl: z.number(),
        proxied: z.boolean(),
      })),
      count: z.number(),
    },
    handler: async (input, _ctx) => {
      const records = await listDnsRecords(input);
      const mapped = records.map((r: any) => ({
        id: r.id, type: r.type, name: r.name, content: r.content, ttl: r.ttl ?? 1, proxied: r.proxied ?? false,
      }));
      return {
        data: { records: mapped, count: mapped.length },
        summary: `Found ${mapped.length} DNS record(s).`,
      };
    },
  }, callerHash);
}
