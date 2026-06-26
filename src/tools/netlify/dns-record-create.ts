import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { createDnsRecord } from '../../netlify/full-client.js';

export function registerNetlifyDnsRecordCreate(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'netlify_dns_record_create',
    category: 'write_orchestrated',
    annotations: {
      title: 'Netlify: create DNS record',
      description: 'Add a DNS record to a Netlify-managed zone (POST /dns_zones/{zone_id}/dns_records). Supports A, AAAA, CNAME, MX, TXT, NS, SRV, CAA. Defaults to dry_run.',
      readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true,
    },
    inputShape: {
      zone_id: z.string().min(1).describe('DNS zone ID to add the record to.'),
      type: z.string().min(1).describe('Record type: A, AAAA, CNAME, MX, TXT, NS, SRV, CAA, etc.'),
      hostname: z.string().min(1).describe('Hostname for the record (e.g. "www" or "mail.example.com").'),
      value: z.string().min(1).describe('Record value (IP, hostname, or text content).'),
      ttl: z.number().int().optional().describe('TTL in seconds. Defaults to 3600.'),
      priority: z.number().int().optional().describe('Priority (required for MX and SRV records).'),
      weight: z.number().int().optional().describe('Weight (SRV records).'),
      port: z.number().int().optional().describe('Port (SRV records).'),
      flag: z.number().int().optional().describe('Flag (CAA records).'),
      tag: z.string().optional().describe('Tag (CAA records): "issue", "issuewild", "iodef".'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      id: z.string().optional(),
      type: z.string().optional(),
      hostname: z.string().optional(),
      value: z.string().optional(),
    },
    handler: async (input, ctx) => {
      const { zone_id, ...record } = input;
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, type: record.type, hostname: record.hostname, value: record.value },
          audit: { before: null, after: input },
          summary: `DRY RUN: would create ${record.type} record for "${record.hostname}" in zone ${zone_id}. Pass dry_run=false to apply.`,
        };
      }
      const r = await createDnsRecord(zone_id, record as any);
      return {
        data: { executed: true, dry_run: false, id: r.id, type: r.type, hostname: r.hostname, value: r.value },
        audit: { before: null, after: r },
        summary: `Created ${r.type} record "${r.hostname}" → "${r.value}" in zone ${zone_id} (id: ${r.id}).`,
      };
    },
  }, callerHash);
}
