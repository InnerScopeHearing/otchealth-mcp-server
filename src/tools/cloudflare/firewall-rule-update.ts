import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { updateFirewallRule } from '../../cloudflare/full-client.js';

export function registerCloudflareFirewallRuleUpdate(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'cloudflare_firewall_rule_update',
    category: 'write_orchestrated',
    annotations: {
      title: 'Update firewall custom rule',
      description: 'Patch an existing firewall custom rule (expression, action, description, or enabled state). Defaults to dry_run.',
      readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      rule_id: z.string().describe('Firewall rule ID to update.'),
      expression: z.string().optional().describe('New filter expression.'),
      action: z.enum(['block', 'challenge', 'js_challenge', 'managed_challenge', 'log', 'skip', 'allow']).optional().describe('New action.'),
      description: z.string().optional().describe('New description.'),
      enabled: z.boolean().optional().describe('Enable or disable the rule.'),
      zone_id: z.string().optional().describe('Zone ID (defaults to CLOUDFLARE_ZONE_ID env var).'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      rule: z.unknown(),
    },
    handler: async (input, ctx) => {
      const { rule_id, zone_id, ...patch } = input;
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, rule: null },
          audit: { before: null, after: input },
          summary: `DRY RUN: would update firewall rule ${rule_id}. Pass dry_run=false to apply.`,
        };
      }
      const rule = await updateFirewallRule(rule_id, patch, zone_id);
      return {
        data: { executed: true, dry_run: false, rule },
        audit: { before: null, after: input },
        summary: `Updated firewall rule ${rule_id}.`,
      };
    },
  }, callerHash);
}
