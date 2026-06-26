import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { exportDnsRecords } from '../../cloudflare/full-client.js';

export function registerCloudflareDnsExport(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'cloudflare_dns_export',
    category: 'read',
    annotations: {
      title: 'Export DNS records (BIND zone file)',
      description: 'Export all DNS records for a zone as a BIND-format zone file.',
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      zone_id: z.string().optional().describe('Zone ID (defaults to CLOUDFLARE_ZONE_ID env var).'),
    },
    outputShape: {
      bind_content: z.string(),
    },
    handler: async (input, _ctx) => {
      const bindContent = await exportDnsRecords(input.zone_id);
      return {
        data: { bind_content: bindContent },
        summary: `Exported zone file (${bindContent.length} chars).`,
      };
    },
  }, callerHash);
}
