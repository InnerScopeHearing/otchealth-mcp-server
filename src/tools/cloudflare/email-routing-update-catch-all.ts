import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { updateEmailCatchAll } from '../../cloudflare/full-client.js';

export function registerCloudflareEmailRoutingUpdateCatchAll(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'cloudflare_email_routing_update_catch_all',
    category: 'write_simple',
    annotations: {
      title: 'Update email catch-all rule',
      description: 'Update the catch-all email routing action (drop, forward, or worker). Defaults to dry_run.',
      readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      enabled: z.boolean().describe('Whether the catch-all rule is active.'),
      action: z.enum(['drop', 'forward', 'worker']).describe('Action for unmatched email: drop, forward to an address, or hand off to a Worker.'),
      forward_to: z.string().email().optional().describe('Destination email address (required when action is "forward").'),
      zone_id: z.string().optional().describe('Zone ID (defaults to CLOUDFLARE_ZONE_ID env var).'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      catch_all: z.unknown(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, catch_all: null },
          audit: { before: null, after: { enabled: input.enabled, action: input.action, forward_to: input.forward_to } },
          summary: `DRY RUN: would update catch-all to [${input.action}] enabled=${input.enabled}. Pass dry_run=false to apply.`,
        };
      }
      const catchAll = await updateEmailCatchAll(input.enabled, input.action, input.forward_to, input.zone_id);
      return {
        data: { executed: true, dry_run: false, catch_all: catchAll },
        audit: { before: null, after: input },
        summary: `Updated catch-all: action=${input.action}, enabled=${input.enabled}.`,
      };
    },
  }, callerHash);
}
