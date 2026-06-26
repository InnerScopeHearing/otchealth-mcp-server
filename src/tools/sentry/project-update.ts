import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { updateProject } from '../../sentry/full-client.js';

export function registerSentryProjectUpdate(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'sentry_project_update',
    category: 'write_simple',
    annotations: {
      title: 'Update Sentry project',
      description: 'Update project metadata (name, platform, bookmark). MedReview PHI projects are blocked. Defaults to dry_run.',
      readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      project_slug: z.string().min(1).describe('Project slug to update (PHI guard). MedReview blocked.'),
      name: z.string().optional().describe('New human-readable name.'),
      platform: z.string().optional().describe('New platform key, e.g. "javascript".'),
      is_bookmarked: z.boolean().optional().describe('Bookmark state.'),
    },
    outputShape: { executed: z.boolean(), dry_run: z.boolean(), upstream_response: z.unknown().nullable() },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, upstream_response: null },
          audit: { before: null, after: input },
          summary: `DRY RUN: would update Sentry project "${input.project_slug}". Pass dry_run=false to apply.`,
        };
      }
      const result = await updateProject(input.project_slug, { name: input.name, platform: input.platform, isBookmarked: input.is_bookmarked });
      return {
        data: { executed: true, dry_run: false, upstream_response: result },
        audit: { before: null, after: input },
        summary: `Sentry project "${input.project_slug}" updated.`,
      };
    },
  }, callerHash);
}
