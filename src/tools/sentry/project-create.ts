import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { createProject } from '../../sentry/full-client.js';

export function registerSentryProjectCreate(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'sentry_project_create',
    category: 'write_orchestrated',
    annotations: {
      title: 'Create Sentry project',
      description: 'Create a new Sentry project under a team. Slugs matching medreview* are blocked. Defaults to dry_run.',
      readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true,
    },
    inputShape: {
      team_slug: z.string().min(1).describe('Team slug that will own the new project.'),
      name: z.string().min(1).describe('Human-readable project name.'),
      slug: z.string().optional().describe('Optional URL-safe slug. Must not start with "medreview".'),
      platform: z.string().optional().describe('Platform key, e.g. "javascript", "python", "node".'),
    },
    outputShape: { executed: z.boolean(), dry_run: z.boolean(), project: z.unknown().nullable() },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, project: null },
          audit: { before: null, after: input },
          summary: `DRY RUN: would create Sentry project "${input.name}" under team "${input.team_slug}". Pass dry_run=false to apply.`,
        };
      }
      const project = await createProject(input.team_slug, input.name, input.slug, input.platform);
      return {
        data: { executed: true, dry_run: false, project },
        audit: { before: null, after: { team_slug: input.team_slug, name: input.name, slug: input.slug } },
        summary: `Sentry project "${input.name}" created.`,
      };
    },
  }, callerHash);
}
