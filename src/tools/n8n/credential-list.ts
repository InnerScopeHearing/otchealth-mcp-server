import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { listCredentials } from '../../n8n/full-client.js';

export function registerN8nCredentialList(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'n8n_credential_list',
    category: 'read',
    annotations: {
      title: 'List n8n credentials (names/types only)',
      description:
        'List n8n credentials returning id, name, type, createdAt, updatedAt ONLY. ' +
        'Credential secret values (data, oauthTokenData) are NEVER returned — this tool is safe for operators to inspect what integrations are configured. ' +
        'Use n8n_credential_schema_get to see the schema for a credential type.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      limit: z.number().int().min(1).max(250).optional().describe('Max results (default 100).'),
      cursor: z.string().optional().describe('Pagination cursor from previous response.'),
    },
    outputShape: {
      credentials: z.array(z.unknown()),
      count: z.number(),
      next_cursor: z.string().nullable(),
    },
    handler: async (input, ctx) => {
      const raw = await listCredentials({
        limit: input.limit,
        cursor: input.cursor,
        correlationId: ctx.correlationId,
      });
      const credentials = raw?.data ?? [];
      return {
        data: { credentials, count: credentials.length, next_cursor: raw?.nextCursor ?? null },
        summary: `Found ${credentials.length} credential(s). Secrets stripped — names/types only.`,
      };
    },
  }, callerHash);
}
