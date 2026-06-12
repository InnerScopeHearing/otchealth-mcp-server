import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { createDnsRecord } from '../../cloudflare/api-client.js';

export function registerCloudflareCreateDnsRecord(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'cloudflare_create_dns_record',
    category: 'write_simple',
    annotations: {
      title: 'Create DNS record',
      description: 'Create a new DNS record on the zone.',
      readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true,
    },
    inputShape: {
      type: z.string().describe('Record type (A, AAAA, CNAME, MX, TXT, etc.).'),
      name: z.string().describe('Record name (e.g. "coo" for coo.otchealth.app, or "@" for root).'),
      content: z.string().describe('Record value (IP address, hostname, text, etc.).'),
      ttl: z.number().int().optional().describe('TTL in seconds (1 = auto).'),
      proxied: z.boolean().optional().describe('Whether to proxy through Cloudflare (default false).'),
      priority: z.number().int().optional().describe('Priority for MX records.'),
    },
    outputShape: {
      record_id: z.string(),
      type: z.string(),
      name: z.string(),
      content: z.string(),
    },
    handler: async (input, _ctx) => {
      const result = await createDnsRecord(input.type, input.name, input.content, {
        ttl: input.ttl, proxied: input.proxied, priority: input.priority,
      });
      const rec = result.result ?? result;
      return {
        data: { record_id: rec.id ?? '', type: input.type, name: input.name, content: input.content },
        summary: `Created ${input.type} record: ${input.name} -> ${input.content}`,
      };
    },
  }, callerHash);
}
