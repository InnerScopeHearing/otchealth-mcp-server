import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { listFirewallRules } from '../../cloudflare/full-client.js';

export function registerCloudflareFirewallRuleList(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'cloudflare_firewall_rule_list',
    category: 'read',
    annotations: {
      title: 'List firewall custom rules',
      description: 'List WAF/firewall custom rules in the zone firewall ruleset.',
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      zone_id: z.string().optional().describe('Zone ID (defaults to CLOUDFLARE_ZONE_ID env var).'),
    },
    outputShape: {
      rules: z.array(z.unknown()),
      count: z.number(),
    },
    handler: async (input, _ctx) => {
      const rules = await listFirewallRules(input.zone_id);
      return {
        data: { rules, count: rules.length },
        summary: `Found ${rules.length} firewall rule(s).`,
      };
    },
  }, callerHash);
}
