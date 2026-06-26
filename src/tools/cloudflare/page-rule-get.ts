import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { getPageRule } from '../../cloudflare/full-client.js';

export function registerCloudflarePageRuleGet(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'cloudflare_page_rule_get',
    category: 'read',
    annotations: {
      title: 'Get page rule',
      description: 'Retrieve a single page rule by ID.',
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      rule_id: z.string().describe('Page rule ID.'),
      zone_id: z.string().optional().describe('Zone ID (defaults to CLOUDFLARE_ZONE_ID env var).'),
    },
    outputShape: {
      rule: z.unknown(),
    },
    handler: async (input, _ctx) => {
      const rule = await getPageRule(input.rule_id, input.zone_id);
      return {
        data: { rule },
        summary: `Page rule ${input.rule_id}.`,
      };
    },
  }, callerHash);
}
