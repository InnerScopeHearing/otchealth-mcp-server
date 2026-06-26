import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { getCredentialSchema } from '../../n8n/full-client.js';

export function registerN8nCredentialSchemaGet(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'n8n_credential_schema_get',
    category: 'read',
    annotations: {
      title: 'Get n8n credential type schema',
      description:
        'Retrieve the JSON Schema for a given n8n credential type (e.g. "githubApi", "slackOAuth2Api"). ' +
        'Shows what fields are required to create a credential of that type. Does NOT return any secret values.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      credential_type: z
        .string()
        .min(1)
        .describe('n8n credential type name, e.g. "githubApi", "slackOAuth2Api", "stripeApi".'),
    },
    outputShape: {
      credential_type: z.string(),
      schema: z.unknown(),
    },
    handler: async (input, ctx) => {
      const schema = await getCredentialSchema(input.credential_type, { correlationId: ctx.correlationId });
      return {
        data: { credential_type: input.credential_type, schema },
        summary: `Retrieved schema for credential type "${input.credential_type}".`,
      };
    },
  }, callerHash);
}
