import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { createPageRule } from '../../cloudflare/full-client.js';

export function registerCloudflarePageRuleCreate(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'cloudflare_page_rule_create',
    category: 'write_simple',
    annotations: {
      title: 'Create page rule',
      description: 'Create a new page rule for a zone. Defaults to dry_run.',
      readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true,
    },
    inputShape: {
      url_pattern: z.string().describe('URL pattern the rule matches (e.g. "example.com/api/*").'),
      actions: z.array(z.object({
        id: z.string().describe('Action ID (e.g. "always_use_https", "forwarding_url", "cache_level").'),
        value: z.unknown().optional().describe('Action value (depends on action type).'),
      })).min(1).describe('Actions to apply when the pattern matches.'),
      priority: z.number().int().optional().describe('Rule priority (lower = higher priority).'),
      status: z.enum(['active', 'disabled']).optional().describe('Initial rule status (default: active).'),
      zone_id: z.string().optional().describe('Zone ID (defaults to CLOUDFLARE_ZONE_ID env var).'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      rule: z.unknown(),
    },
    handler: async (input, ctx) => {
      const targets = [{ target: 'url', constraint: { operator: 'matches', value: input.url_pattern } }];
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, rule: null },
          audit: { before: null, after: { url_pattern: input.url_pattern, actions: input.actions } },
          summary: `DRY RUN: would create page rule for "${input.url_pattern}". Pass dry_run=false to apply.`,
        };
      }
      const rule = await createPageRule(targets, input.actions as any, { priority: input.priority, status: input.status }, input.zone_id);
      return {
        data: { executed: true, dry_run: false, rule },
        audit: { before: null, after: input },
        summary: `Created page rule for "${input.url_pattern}".`,
      };
    },
  }, callerHash);
}
