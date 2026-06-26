import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { updateRelease } from '../../sentry/full-client.js';

export function registerSentryReleaseUpdate(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'sentry_release_update',
    category: 'write_simple',
    annotations: {
      title: 'Update a Sentry release',
      description: 'Update metadata on an existing Sentry release (projects, ref, url, dateReleased). PHI project slugs are blocked. Defaults to dry_run.',
      readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      version: z.string().min(1).describe('Release version string to update.'),
      projects: z.array(z.string()).optional().describe('Project slugs to associate. MedReview slugs are blocked.'),
      ref: z.string().optional().describe('Short reference (git SHA / branch).'),
      url: z.string().url().optional().describe('URL to the release page.'),
      date_released: z.string().optional().describe('ISO 8601 release datetime.'),
    },
    outputShape: { executed: z.boolean(), dry_run: z.boolean(), upstream_response: z.unknown().nullable() },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, upstream_response: null },
          audit: { before: null, after: input },
          summary: `DRY RUN: would update release "${input.version}". Pass dry_run=false to apply.`,
        };
      }
      const result = await updateRelease(input.version, { projects: input.projects, ref: input.ref, url: input.url, dateReleased: input.date_released });
      return {
        data: { executed: true, dry_run: false, upstream_response: result },
        audit: { before: null, after: input },
        summary: `Release "${input.version}" updated.`,
      };
    },
  }, callerHash);
}
