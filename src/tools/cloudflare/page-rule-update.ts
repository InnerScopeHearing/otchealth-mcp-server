import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { updatePageRule } from '../../cloudflare/full-client.js';

export function registerCloudflarePageRuleUpdate(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'cloudflare_page_rule_update',
    category: 'write_simple',
    annotations: {
      title: 'Update page rule',
      description: 'Full replacement of a page rule (PUT). Defaults to dry_run.',
      readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      rule_id: z.string().describe('Page rule ID to update.'),
      url_pattern: z.string().describe('URL pattern the rule matches.'),
      actions: z.array(z.object({
        id: z.string(),
        value: z.unknown().optional(),
      })).min(1).describe('Replacement action list.'),
      priority: z.number().int().optional().describe('Rule priority.'),
      status: z.enum(['active', 'disabled']).optional().describe('Rule status.'),
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
          audit: { before: null, after: input },
          summary: `DRY RUN: would update page rule ${input.rule_id}. Pass dry_run=false to apply.`,
        };
      }
      const rule = await updatePageRule(input.rule_id, targets, input.actions as any, { priority: input.priority, status: input.status }, input.zone_id);
      return {
        data: { executed: true, dry_run: false, rule },
        audit: { before: null, after: input },
        summary: `Updated page rule ${input.rule_id}.`,
      };
    },
  }, callerHash);
}
