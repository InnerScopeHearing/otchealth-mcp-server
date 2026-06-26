import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { deleteRelease } from '../../sentry/full-client.js';

export function registerSentryReleaseDelete(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'sentry_release_delete',
    category: 'write_orchestrated',
    annotations: {
      title: 'Delete a Sentry release',
      description: 'Permanently delete a Sentry release. Irreversible. Defaults to dry_run.',
      readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true,
    },
    inputShape: {
      version: z.string().min(1).describe('Release version string to delete.'),
    },
    outputShape: { executed: z.boolean(), dry_run: z.boolean(), version: z.string() },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, version: input.version },
          audit: { before: null, after: { version: input.version } },
          summary: `DRY RUN: would permanently delete release "${input.version}". Pass dry_run=false to apply.`,
        };
      }
      await deleteRelease(input.version);
      return {
        data: { executed: true, dry_run: false, version: input.version },
        audit: { before: { version: input.version }, after: null },
        summary: `Release "${input.version}" deleted.`,
      };
    },
  }, callerHash);
}
