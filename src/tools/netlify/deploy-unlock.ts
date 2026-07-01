import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { unlockDeploy } from '../../netlify/full-client.js';

export function registerNetlifyDeployUnlock(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'netlify_deploy_unlock',
    category: 'write_orchestrated',
    annotations: {
      title: 'Netlify: unlock deploy',
      description: 'Unlock a locked deploy so future publishes can replace it (POST /deploys/{id}/unlock). Defaults to dry_run.',
      readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      deploy_id: z.string().min(1).describe('Deploy ID to unlock.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      deploy_id: z.string().optional(),
      locked: z.boolean().optional(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, deploy_id: input.deploy_id },
          audit: { before: null, after: input },
          summary: `DRY RUN: would unlock deploy ${input.deploy_id}. Pass dry_run=false to apply.`,
        };
      }
      const d = await unlockDeploy(input.deploy_id);
      return {
        data: { executed: true, dry_run: false, deploy_id: d.id ?? input.deploy_id, locked: d.locked ?? false },
        audit: { before: null, after: d },
        summary: `Unlocked deploy ${d.id ?? input.deploy_id}.`,
      };
    },
  }, callerHash);
}
