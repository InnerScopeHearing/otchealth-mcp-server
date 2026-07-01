import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { listDnsZones } from '../../netlify/full-client.js';

export function registerNetlifyDnsZoneList(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'netlify_dns_zone_list',
    category: 'read',
    annotations: {
      title: 'Netlify: list DNS zones',
      description: 'List all DNS zones managed by Netlify (GET /dns_zones). Optionally filter by account slug.',
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      account_slug: z.string().optional().describe('Filter zones by account slug.'),
    },
    outputShape: {
      zones: z.array(z.object({
        id: z.string(),
        name: z.string(),
        site_id: z.string().nullable(),
        account_id: z.string().nullable(),
        created_at: z.string().nullable(),
        errors: z.array(z.string()),
      })),
      count: z.number(),
    },
    handler: async (input, _ctx) => {
      const raw = await listDnsZones(input.account_slug ? { account_slug: input.account_slug } : undefined);
      const zones = (raw ?? []).map((z: any) => ({
        id: z.id ?? '',
        name: z.name ?? '',
        site_id: z.site_id ?? null,
        account_id: z.account_id ?? null,
        created_at: z.created_at ?? null,
        errors: z.errors ?? [],
      }));
      return {
        data: { zones, count: zones.length },
        summary: `Found ${zones.length} DNS zone(s).`,
      };
    },
  }, callerHash);
}
