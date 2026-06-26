import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { createProject } from '../../n8n/full-client.js';

export function registerN8nProjectCreate(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'n8n_project_create',
    category: 'write_simple',
    annotations: {
      title: 'Create n8n project',
      description:
        'Create a new project in n8n for organizing workflows and credentials. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputShape: {
      name: z.string().min(1).describe('Name of the new project.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      project_id: z.string().nullable(),
      name: z.string(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, project_id: null, name: input.name },
          audit: { before: null, after: input },
          summary: `DRY RUN: would create project "${input.name}". Pass dry_run=false to apply.`,
        };
      }
      const upstream = await createProject({ name: input.name, correlationId: ctx.correlationId });
      return {
        data: {
          executed: true, dry_run: false,
          project_id: upstream?.id ?? null,
          name: upstream?.name ?? input.name,
        },
        audit: { before: null, after: { project_id: upstream?.id, name: input.name } },
        summary: `Created project "${input.name}" (id: ${upstream?.id ?? 'unknown'}).`,
      };
    },
  }, callerHash);
}
