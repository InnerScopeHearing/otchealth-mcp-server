import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { createDnsZone } from '../../netlify/full-client.js';

export function registerNetlifyDnsZoneCreate(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'netlify_dns_zone_create',
    category: 'write_orchestrated',
    annotations: {
      title: 'Netlify: create DNS zone',
      description: 'Create a new Netlify-managed DNS zone for a domain (POST /dns_zones). DNS changes are high-risk. Defaults to dry_run.',
      readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true,
    },
    inputShape: {
      name: z.string().min(1).describe('Domain name for the zone (e.g. "example.com").'),
      account_slug: z.string().optional().describe('Account slug to create the zone under.'),
      site_id: z.string().optional().describe('Associate with a specific site ID.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      id: z.string().optional(),
      name: z.string().optional(),
      dns_servers: z.array(z.string()).optional(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true },
          audit: { before: null, after: input },
          summary: `DRY RUN: would create DNS zone for "${input.name}". Pass dry_run=false to apply.`,
        };
      }
      const zone = await createDnsZone({ name: input.name, account_slug: input.account_slug, site_id: input.site_id });
      return {
        data: { executed: true, dry_run: false, id: zone.id, name: zone.name, dns_servers: zone.dns_servers ?? [] },
        audit: { before: null, after: zone },
        summary: `Created DNS zone "${zone.name}" (${zone.id}). Point your registrar to: ${(zone.dns_servers ?? []).join(', ')}.`,
      };
    },
  }, callerHash);
}
