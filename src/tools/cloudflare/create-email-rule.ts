import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { createEmailRoutingRule } from '../../cloudflare/api-client.js';

export function registerCloudflareCreateEmailRule(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'cloudflare_create_email_rule',
    category: 'write_simple',
    annotations: {
      title: 'Create email routing rule',
      description: 'Create a new email routing rule that forwards mail from an address to a destination.',
      readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true,
    },
    inputShape: {
      name: z.string().describe('Rule name (e.g. "Fleet: COO").'),
      match_address: z.string().email().describe('The address to match (e.g. coo@otchealth.app).'),
      forward_to: z.string().email().describe('The destination to forward to (e.g. bot-xxx@bot.hyperagent.email).'),
    },
    outputShape: {
      rule_id: z.string(),
      name: z.string(),
      match_address: z.string(),
      forward_to: z.string(),
      enabled: z.boolean(),
    },
    handler: async (input, _ctx) => {
      const result = await createEmailRoutingRule(input.name, input.match_address, input.forward_to);
      const rule = result.result ?? result;
      return {
        data: {
          rule_id: rule.id ?? '',
          name: input.name,
          match_address: input.match_address,
          forward_to: input.forward_to,
          enabled: true,
        },
        summary: `Created rule "${input.name}": ${input.match_address} -> ${input.forward_to}`,
      };
    },
  }, callerHash);
}
