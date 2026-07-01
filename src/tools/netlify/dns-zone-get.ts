import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { getDnsZone } from '../../netlify/full-client.js';

export function registerNetlifyDnsZoneGet(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'netlify_dns_zone_get',
    category: 'read',
    annotations: {
      title: 'Netlify: get DNS zone details',
      description: 'Fetch full details for a single DNS zone by ID (GET /dns_zones/{zone_id}). Returns nameservers and status.',
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      zone_id: z.string().min(1).describe('DNS zone ID.'),
    },
    outputShape: {
      id: z.string(),
      name: z.string(),
      site_id: z.string().nullable(),
      account_id: z.string().nullable(),
      dns_servers: z.array(z.string()),
      created_at: z.string().nullable(),
    },
    handler: async (input, _ctx) => {
      const z = await getDnsZone(input.zone_id);
      return {
        data: {
          id: z.id ?? '',
          name: z.name ?? '',
          site_id: z.site_id ?? null,
          account_id: z.account_id ?? null,
          dns_servers: z.dns_servers ?? [],
          created_at: z.created_at ?? null,
        },
        summary: `DNS zone "${z.name}" (${z.id}) — servers: ${(z.dns_servers ?? []).join(', ') || 'none'}.`,
      };
    },
  }, callerHash);
}
