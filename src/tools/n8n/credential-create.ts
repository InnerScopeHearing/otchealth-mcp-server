import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { createCredential } from '../../n8n/full-client.js';

export function registerN8nCredentialCreate(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'n8n_credential_create',
    category: 'write_orchestrated',
    annotations: {
      title: 'Create n8n credential',
      description:
        'Create a new n8n credential entry. The data object should contain the credential fields per the type schema (use n8n_credential_schema_get to see required fields). ' +
        'IMPORTANT: The credential data you supply is stored encrypted in n8n and is NEVER echoed back in the response — only id/name/type are returned. ' +
        'Classified write_orchestrated because it provisions persistent auth material. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputShape: {
      name: z.string().min(1).describe('Human-readable name for this credential entry.'),
      type: z.string().min(1).describe('n8n credential type, e.g. "githubApi". Use n8n_credential_schema_get to list fields.'),
      data: z
        .record(z.unknown())
        .describe('Credential fields per the type schema. These are encrypted at rest; never returned in responses.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      credential_id: z.string().nullable(),
      name: z.string(),
      type: z.string(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: {
            executed: false, dry_run: true,
            credential_id: null,
            name: input.name,
            type: input.type,
          },
          // Never echo data fields in audit
          audit: { before: null, after: { name: input.name, type: input.type } },
          summary: `DRY RUN: would create credential "${input.name}" of type "${input.type}". Pass dry_run=false to apply.`,
        };
      }
      const upstream = await createCredential({
        name: input.name,
        type: input.type,
        data: input.data as Record<string, unknown>,
        correlationId: ctx.correlationId,
      });
      return {
        data: {
          executed: true, dry_run: false,
          credential_id: upstream?.id ?? null,
          name: upstream?.name ?? input.name,
          type: upstream?.type ?? input.type,
        },
        // Never log the data values
        audit: { before: null, after: { credential_id: upstream?.id, name: input.name, type: input.type } },
        summary: `Created credential "${input.name}" (id: ${upstream?.id ?? 'unknown'}, type: ${input.type}). Secret values not returned.`,
      };
    },
  }, callerHash);
}
