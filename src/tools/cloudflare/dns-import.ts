import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { importDnsRecords } from '../../cloudflare/full-client.js';

export function registerCloudflareDnsImport(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'cloudflare_dns_import',
    category: 'write_orchestrated',
    annotations: {
      title: 'Import DNS records (BIND zone file)',
      description: 'Import DNS records from a BIND-format zone file. This is a bulk DNS write that may overwrite records. Defaults to dry_run.',
      readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true,
    },
    inputShape: {
      bind_content: z.string().describe('BIND-format zone file contents to import.'),
      proxied: z.boolean().optional().describe('Whether imported records should be Cloudflare-proxied (default false).'),
      zone_id: z.string().optional().describe('Zone ID (defaults to CLOUDFLARE_ZONE_ID env var).'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      result: z.unknown(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, result: null },
          audit: { before: null, after: { bind_content_length: input.bind_content.length, proxied: input.proxied } },
          summary: `DRY RUN: would import BIND zone file (${input.bind_content.length} chars). Pass dry_run=false to apply.`,
        };
      }
      const result = await importDnsRecords(input.bind_content, input.proxied, input.zone_id);
      return {
        data: { executed: true, dry_run: false, result },
        audit: { before: null, after: { bind_content_length: input.bind_content.length, proxied: input.proxied } },
        summary: `Imported DNS records from BIND zone file.`,
      };
    },
  }, callerHash);
}
