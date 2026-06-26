import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { getEmailRoutingDnsRecords } from '../../cloudflare/full-client.js';

export function registerCloudflareEmailRoutingDnsRecords(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'cloudflare_email_routing_dns_records',
    category: 'read',
    annotations: {
      title: 'Get required DNS records for email routing',
      description: 'Returns the DNS records that must be present for Cloudflare Email Routing to function.',
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      zone_id: z.string().optional().describe('Zone ID (defaults to CLOUDFLARE_ZONE_ID env var).'),
    },
    outputShape: {
      records: z.array(z.unknown()),
      count: z.number(),
    },
    handler: async (input, _ctx) => {
      const records = await getEmailRoutingDnsRecords(input.zone_id);
      return {
        data: { records, count: records.length },
        summary: `${records.length} DNS record(s) required for email routing.`,
      };
    },
  }, callerHash);
}
