import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { deleteRateLimitRule } from '../../cloudflare/full-client.js';

export function registerCloudflareRateLimitRuleDelete(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'cloudflare_rate_limit_rule_delete',
    category: 'write_orchestrated',
    annotations: {
      title: 'Delete rate-limit rule',
      description: 'Remove a rate-limiting rule from the zone ruleset. Irreversible. Defaults to dry_run.',
      readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true,
    },
    inputShape: {
      rule_id: z.string().describe('Rate-limit rule ID to delete.'),
      zone_id: z.string().optional().describe('Zone ID (defaults to CLOUDFLARE_ZONE_ID env var).'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      deleted: z.boolean(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, deleted: false },
          audit: { before: { rule_id: input.rule_id }, after: null },
          summary: `DRY RUN: would delete rate-limit rule ${input.rule_id}. Pass dry_run=false to apply.`,
        };
      }
      const result = await deleteRateLimitRule(input.rule_id, input.zone_id);
      return {
        data: { executed: true, dry_run: false, deleted: result.deleted },
        audit: { before: { rule_id: input.rule_id }, after: null },
        summary: `Deleted rate-limit rule ${input.rule_id}.`,
      };
    },
  }, callerHash);
}
