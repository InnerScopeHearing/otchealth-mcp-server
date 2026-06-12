import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { addEmailRoutingDestination } from '../../cloudflare/api-client.js';

export function registerCloudflareAddEmailDestination(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'cloudflare_add_email_destination',
    category: 'write_simple',
    annotations: {
      title: 'Add email routing destination',
      description: 'Add a new destination email address for Cloudflare email routing. Triggers a verification email to the address.',
      readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true,
    },
    inputShape: {
      email: z.string().email().describe('The destination email address to add (e.g. bot-xxx@bot.hyperagent.email).'),
    },
    outputShape: {
      email: z.string(),
      verified: z.boolean(),
      message: z.string(),
    },
    handler: async (input, _ctx) => {
      const result = await addEmailRoutingDestination(input.email);
      const entry = result.result ?? result;
      return {
        data: {
          email: entry.email ?? input.email,
          verified: entry.verified ?? false,
          message: entry.already_exists ? 'Destination already exists.' : 'Destination added. Verification email sent.',
        },
        summary: `Added destination ${input.email}. Verification email sent.`,
      };
    },
  }, callerHash);
}
