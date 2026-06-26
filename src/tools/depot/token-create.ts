import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { createProjectToken } from '../../depot/full-client.js';

export function registerDepotTokenCreate(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'depot_token_create',
    category: 'write_simple',
    annotations: {
      title: 'Depot: create project token',
      description: 'Create a new Depot project token (for CI environments without OIDC). Returns token metadata and tokenId ONLY — never logs the secret value. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputShape: {
      project_id: z.string().describe('The Depot project ID.'),
      description: z.string().describe('Human-readable label for the token (e.g. "github-actions-prod").'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      token_id: z.string().optional(),
      description: z.string().optional(),
      created_at: z.string().optional(),
      note: z.string().optional(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, description: input.description },
          audit: { before: null, after: input },
          summary: `DRY RUN: would create project token "${input.description}" for project ${input.project_id}. Pass dry_run=false to apply.`,
        };
      }
      const result = await createProjectToken({
        projectId: input.project_id,
        description: input.description,
      });
      const tok = result?.token ?? result;
      // Deliberately never return the tokenValue — it must be read from Depot dashboard
      return {
        data: {
          executed: true,
          dry_run: false,
          token_id: tok?.tokenId,
          description: tok?.description,
          created_at: tok?.createdAt,
          note: 'Secret token value is NOT returned by this tool. Retrieve it from the Depot dashboard immediately after creation.',
        },
        audit: { before: null, after: { tokenId: tok?.tokenId, description: tok?.description } },
        summary: `Created Depot project token "${tok?.description}" (ID: ${tok?.tokenId}). Retrieve the secret value from the Depot dashboard.`,
      };
    },
  }, callerHash);
}
