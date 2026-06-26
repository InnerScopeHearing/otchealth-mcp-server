import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { getDnssec } from '../../cloudflare/full-client.js';

export function registerCloudflareDnssecGet(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'cloudflare_dnssec_get',
    category: 'read',
    annotations: {
      title: 'Get DNSSEC status',
      description: 'Retrieve DNSSEC configuration and DS record details for a zone.',
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      zone_id: z.string().optional().describe('Zone ID (defaults to CLOUDFLARE_ZONE_ID env var).'),
    },
    outputShape: {
      dnssec: z.unknown(),
    },
    handler: async (input, _ctx) => {
      const dnssec = await getDnssec(input.zone_id);
      return {
        data: { dnssec },
        summary: `DNSSEC status: ${(dnssec as any)?.status ?? 'unknown'}`,
      };
    },
  }, callerHash);
}
