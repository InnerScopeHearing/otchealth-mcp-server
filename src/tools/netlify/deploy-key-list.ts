import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { listDeployKeys } from '../../netlify/full-client.js';

export function registerNetlifyDeployKeyList(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'netlify_deploy_key_list',
    category: 'read',
    annotations: {
      title: 'Netlify: list deploy keys',
      description: 'List all deploy keys (SSH public keys) associated with the account (GET /deploy_keys).',
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {},
    outputShape: {
      keys: z.array(z.object({
        id: z.string(),
        public_key: z.string().nullable(),
        created_at: z.string().nullable(),
      })),
      count: z.number(),
    },
    handler: async (_input, _ctx) => {
      const raw = await listDeployKeys();
      const keys = (raw ?? []).map((k: any) => ({
        id: k.id ?? '',
        public_key: k.public_key ?? null,
        created_at: k.created_at ?? null,
      }));
      return {
        data: { keys, count: keys.length },
        summary: `Found ${keys.length} deploy key(s).`,
      };
    },
  }, callerHash);
}
