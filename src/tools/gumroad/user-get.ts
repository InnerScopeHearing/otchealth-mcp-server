import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { getUser } from '../../gumroad/full-client.js';

export function registerGumroadUserGet(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'gumroad_user_get',
    category: 'read',
    annotations: {
      title: 'Get Gumroad authenticated user',
      description: 'Retrieve account information for the authenticated Gumroad creator (name, email, bio, currency, url).',
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {},
    outputShape: {
      user: z.object({
        id: z.string(),
        name: z.string(),
        email: z.string(),
        bio: z.string().nullable(),
        twitter_handle: z.string().nullable(),
        user_id: z.string(),
        url: z.string().nullable(),
        currency: z.string(),
      }),
    },
    handler: async (_input, _ctx) => {
      const resp = await getUser();
      const u = resp.user ?? resp;
      return {
        data: {
          user: {
            id: u.id ?? u.user_id ?? '',
            name: u.name ?? '',
            email: u.email ?? '',
            bio: u.bio ?? null,
            twitter_handle: u.twitter_handle ?? null,
            user_id: u.user_id ?? u.id ?? '',
            url: u.profile_url ?? null,
            currency: u.currency ?? 'usd',
          },
        },
        summary: `Authenticated as ${u.name ?? u.email}.`,
      };
    },
  }, callerHash);
}
