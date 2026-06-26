import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { createDeployKey } from '../../netlify/full-client.js';

export function registerNetlifyDeployKeyCreate(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'netlify_deploy_key_create',
    category: 'write_simple',
    annotations: {
      title: 'Netlify: create deploy key',
      description: 'Generate a new SSH deploy key pair (POST /deploy_keys). Returns the public key to add to your repo. Defaults to dry_run.',
      readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true,
    },
    inputShape: {},
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      id: z.string().optional(),
      public_key: z.string().optional(),
      created_at: z.string().optional(),
    },
    handler: async (_input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true },
          audit: { before: null, after: {} },
          summary: 'DRY RUN: would generate a new Netlify deploy key pair. Pass dry_run=false to apply.',
        };
      }
      const k = await createDeployKey();
      return {
        data: { executed: true, dry_run: false, id: k.id, public_key: k.public_key, created_at: k.created_at },
        audit: { before: null, after: { id: k.id } },
        summary: `Created deploy key ${k.id}. Add the public_key to your repository's deploy keys.`,
      };
    },
  }, callerHash);
}
