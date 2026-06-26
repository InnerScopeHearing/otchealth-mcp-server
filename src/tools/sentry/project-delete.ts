import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { deleteProject } from '../../sentry/full-client.js';

export function registerSentryProjectDelete(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'sentry_project_delete',
    category: 'write_orchestrated',
    annotations: {
      title: 'Delete Sentry project',
      description: 'Permanently delete a Sentry project and all its data. Irreversible. MedReview PHI projects are blocked. Defaults to dry_run.',
      readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true,
    },
    inputShape: {
      project_slug: z.string().min(1).describe('Project slug to delete (PHI guard). MedReview blocked.'),
    },
    outputShape: { executed: z.boolean(), dry_run: z.boolean(), project_slug: z.string() },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, project_slug: input.project_slug },
          audit: { before: null, after: { project_slug: input.project_slug } },
          summary: `DRY RUN: would permanently delete Sentry project "${input.project_slug}". Pass dry_run=false to apply.`,
        };
      }
      await deleteProject(input.project_slug);
      return {
        data: { executed: true, dry_run: false, project_slug: input.project_slug },
        audit: { before: { project_slug: input.project_slug }, after: null },
        summary: `Sentry project "${input.project_slug}" deleted.`,
      };
    },
  }, callerHash);
}
