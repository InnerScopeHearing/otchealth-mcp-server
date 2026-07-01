import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { createProjectKey } from '../../sentry/full-client.js';

export function registerSentryProjectCreateKey(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'sentry_project_create_key',
    category: 'write_simple',
    annotations: {
      title: 'Create Sentry project DSN key',
      description: 'Create a new client key (DSN) for a Sentry project. MedReview PHI projects are blocked. Defaults to dry_run.',
      readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true,
    },
    inputShape: {
      project_slug: z.string().min(1).describe('Project slug (PHI guard). MedReview blocked.'),
      name: z.string().min(1).describe('Label for the new key, e.g. "iOS Production".'),
    },
    outputShape: { executed: z.boolean(), dry_run: z.boolean(), key: z.unknown().nullable() },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, key: null },
          audit: { before: null, after: input },
          summary: `DRY RUN: would create DSN key "${input.name}" in project "${input.project_slug}". Pass dry_run=false to apply.`,
        };
      }
      const key = await createProjectKey(input.project_slug, input.name);
      return {
        data: { executed: true, dry_run: false, key },
        audit: { before: null, after: input },
        summary: `DSN key "${input.name}" created in project "${input.project_slug}".`,
      };
    },
  }, callerHash);
}
