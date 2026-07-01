import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { createReleaseDeploy } from '../../sentry/full-client.js';

export function registerSentryReleaseCreateDeploy(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'sentry_release_create_deploy',
    category: 'write_orchestrated',
    annotations: {
      title: 'Create a Sentry release deploy',
      description: 'Record a deploy for a Sentry release in a given environment (marks production deploys). Defaults to dry_run.',
      readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true,
    },
    inputShape: {
      version: z.string().min(1).describe('Release version string to attach the deploy to.'),
      environment: z.string().min(1).describe('Deployment environment name, e.g. "production", "staging".'),
      name: z.string().optional().describe('Optional deploy name/label.'),
      url: z.string().url().optional().describe('URL for the deploy (e.g. Netlify deploy URL).'),
      date_started: z.string().optional().describe('ISO 8601 datetime the deploy started.'),
      date_finished: z.string().optional().describe('ISO 8601 datetime the deploy finished.'),
    },
    outputShape: { executed: z.boolean(), dry_run: z.boolean(), deploy: z.unknown().nullable() },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, deploy: null },
          audit: { before: null, after: input },
          summary: `DRY RUN: would create deploy for release "${input.version}" in "${input.environment}". Pass dry_run=false to apply.`,
        };
      }
      const deploy = await createReleaseDeploy(input.version, {
        environment: input.environment,
        name: input.name,
        url: input.url,
        dateStarted: input.date_started,
        dateFinished: input.date_finished,
      });
      return {
        data: { executed: true, dry_run: false, deploy },
        audit: { before: null, after: input },
        summary: `Deploy for release "${input.version}" in "${input.environment}" created.`,
      };
    },
  }, callerHash);
}
