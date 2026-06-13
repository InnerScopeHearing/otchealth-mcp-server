import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { listEmailRoutingRules } from '../../cloudflare/api-client.js';

export function registerCloudflareListEmailRules(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'cloudflare_list_email_rules',
    category: 'read',
    annotations: {
      title: 'List Cloudflare email routing rules',
      description: 'List all email routing rules on the zone, showing which addresses forward where.',
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {},
    outputShape: {
      rules: z.array(z.object({
        id: z.string(),
        name: z.string(),
        enabled: z.boolean(),
        match_address: z.string(),
        forward_to: z.string(),
      })),
      count: z.number(),
    },
    handler: async (_input, _ctx) => {
      const rules = await listEmailRoutingRules();
      const mapped = rules.map((r: any) => ({
        id: r.id ?? '',
        name: r.name ?? '',
        enabled: r.enabled ?? true,
        match_address: r.matchers?.[0]?.value ?? '',
        forward_to: r.actions?.[0]?.value?.[0] ?? '',
      }));
      return {
        data: { rules: mapped, count: mapped.length },
        summary: `Found ${mapped.length} email routing rule(s).`,
      };
    },
  }, callerHash);
}
