import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { createFirewallRule } from '../../cloudflare/full-client.js';

export function registerCloudflareFirewallRuleCreate(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'cloudflare_firewall_rule_create',
    category: 'write_orchestrated',
    annotations: {
      title: 'Create firewall custom rule',
      description: 'Add a new WAF/firewall custom rule using Wireshark-style filter expressions. Defaults to dry_run.',
      readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true,
    },
    inputShape: {
      expression: z.string().describe('Firewall expression (e.g. "(ip.src eq 1.2.3.4)").'),
      action: z.enum(['block', 'challenge', 'js_challenge', 'managed_challenge', 'log', 'skip', 'allow']).describe('Action to take when expression matches.'),
      description: z.string().describe('Human-readable description for the rule.'),
      enabled: z.boolean().optional().describe('Whether the rule is enabled (default true).'),
      zone_id: z.string().optional().describe('Zone ID (defaults to CLOUDFLARE_ZONE_ID env var).'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      rule: z.unknown(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, rule: null },
          audit: { before: null, after: { expression: input.expression, action: input.action, description: input.description } },
          summary: `DRY RUN: would create firewall rule [${input.action}] for expression "${input.expression}". Pass dry_run=false to apply.`,
        };
      }
      const rule = await createFirewallRule(input.expression, input.action, input.description, input.enabled ?? true, input.zone_id);
      return {
        data: { executed: true, dry_run: false, rule },
        audit: { before: null, after: input },
        summary: `Created firewall rule [${input.action}] for "${input.description}".`,
      };
    },
  }, callerHash);
}
