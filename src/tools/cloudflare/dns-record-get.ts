import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { getDnsRecord } from '../../cloudflare/full-client.js';

export function registerCloudflareDnsRecordGet(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'cloudflare_dns_record_get',
    category: 'read',
    annotations: {
      title: 'Get DNS record',
      description: 'Retrieve a single DNS record by its ID.',
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      record_id: z.string().describe('DNS record ID.'),
      zone_id: z.string().optional().describe('Zone ID (defaults to CLOUDFLARE_ZONE_ID env var).'),
    },
    outputShape: {
      record: z.unknown(),
    },
    handler: async (input, _ctx) => {
      const record = await getDnsRecord(input.record_id, input.zone_id);
      return {
        data: { record },
        summary: `DNS record ${input.record_id}: ${(record as any)?.type} ${(record as any)?.name}`,
      };
    },
  }, callerHash);
}
