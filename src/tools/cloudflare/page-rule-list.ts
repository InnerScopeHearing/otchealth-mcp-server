import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { listPageRules } from '../../cloudflare/full-client.js';

export function registerCloudflarePageRuleList(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'cloudflare_page_rule_list',
    category: 'read',
    annotations: {
      title: 'List page rules',
      description: 'List all page rules for a zone.',
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      status: z.enum(['active', 'disabled']).optional().describe('Filter by status.'),
      order: z.enum(['status', 'priority']).optional().describe('Sort order.'),
      zone_id: z.string().optional().describe('Zone ID (defaults to CLOUDFLARE_ZONE_ID env var).'),
    },
    outputShape: {
      rules: z.array(z.unknown()),
      count: z.number(),
    },
    handler: async (input, _ctx) => {
      const rules = await listPageRules({ status: input.status, order: input.order }, input.zone_id);
      return {
        data: { rules, count: rules.length },
        summary: `Found ${rules.length} page rule(s).`,
      };
    },
  }, callerHash);
}
