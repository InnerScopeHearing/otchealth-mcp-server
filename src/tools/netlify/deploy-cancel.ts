import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { cancelDeploy } from '../../netlify/full-client.js';

export function registerNetlifyDeployCancel(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'netlify_deploy_cancel',
    category: 'write_orchestrated',
    annotations: {
      title: 'Netlify: cancel in-progress deploy',
      description: 'Cancel a running or enqueued deploy (POST /deploys/{id}/cancel). Only effective while the deploy is building. Defaults to dry_run.',
      readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true,
    },
    inputShape: {
      deploy_id: z.string().min(1).describe('Deploy ID to cancel.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      deploy_id: z.string().optional(),
      state: z.string().optional(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, deploy_id: input.deploy_id },
          audit: { before: null, after: input },
          summary: `DRY RUN: would cancel deploy ${input.deploy_id}. Pass dry_run=false to apply.`,
        };
      }
      const d = await cancelDeploy(input.deploy_id);
      return {
        data: { executed: true, dry_run: false, deploy_id: d.id ?? input.deploy_id, state: d.state },
        audit: { before: null, after: d },
        summary: `Cancelled deploy ${d.id ?? input.deploy_id} (state: ${d.state ?? 'cancelled'}).`,
      };
    },
  }, callerHash);
}
