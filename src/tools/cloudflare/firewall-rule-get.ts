import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { getFirewallRule } from '../../cloudflare/full-client.js';

export function registerCloudflareFirewallRuleGet(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'cloudflare_firewall_rule_get',
    category: 'read',
    annotations: {
      title: 'Get firewall custom rule',
      description: 'Retrieve a single firewall custom rule by its rule ID.',
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      rule_id: z.string().describe('Firewall rule ID.'),
      zone_id: z.string().optional().describe('Zone ID (defaults to CLOUDFLARE_ZONE_ID env var).'),
    },
    outputShape: {
      rule: z.unknown(),
    },
    handler: async (input, _ctx) => {
      const rule = await getFirewallRule(input.rule_id, input.zone_id);
      return {
        data: { rule },
        summary: `Firewall rule ${input.rule_id}: ${(rule as any)?.description ?? ''}`,
      };
    },
  }, callerHash);
}
