import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { listRateLimitRules } from '../../cloudflare/full-client.js';

export function registerCloudflareRateLimitRuleList(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'cloudflare_rate_limit_rule_list',
    category: 'read',
    annotations: {
      title: 'List rate-limit rules',
      description: 'List all rate-limiting rules for a zone.',
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
      const rules = await listRateLimitRules(input.zone_id);
      return {
        data: { rules, count: rules.length },
        summary: `Found ${rules.length} rate-limit rule(s).`,
      };
    },
  }, callerHash);
}
