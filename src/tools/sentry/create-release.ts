import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { createRelease } from '../../sentry/write-client.js';

export function registerSentryCreateRelease(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'sentry_create_release',
    category: 'write_simple',
    annotations: {
      title: 'Create Sentry release',
      description:
        'Create a new release in the Sentry organization (POST /api/0/organizations/{org}/releases/). Associates the release with one or more project slugs. MedReview PHI projects are blocked. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputShape: {
      version: z
        .string()
        .min(1)
        .describe('Unique release version string (e.g. "2.4.1", "abc1234", "my-app@1.0.0+build123").'),
      projects: z
        .array(z.string().min(1))
        .min(1)
        .describe('Project slug(s) to associate with this release. MedReview PHI projects are blocked.'),
      ref: z
        .string()
        .optional()
        .describe('Short reference to the source revision (e.g. a git SHA or branch name).'),
      url: z
        .string()
        .url()
        .optional()
        .describe('URL to the release page (e.g. a GitHub Releases or Changelog URL).'),
      date_released: z
        .string()
        .optional()
        .describe('ISO 8601 datetime the release went live. Defaults to now if omitted.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      version: z.string(),
      projects: z.array(z.string()),
      upstream_response: z.unknown().nullable(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: {
            executed: false,
            dry_run: true,
            version: input.version,
            projects: input.projects,
            upstream_response: null,
          },
          audit: { before: null, after: { version: input.version, projects: input.projects } },
          summary: `DRY RUN: would create Sentry release "${input.version}" for projects [${input.projects.join(', ')}]. Pass dry_run=false to apply.`,
        };
      }
      const upstream = await createRelease({
        version: input.version,
        projects: input.projects,
        ref: input.ref,
        url: input.url,
        dateReleased: input.date_released,
      });
      return {
        data: {
          executed: true,
          dry_run: false,
          version: input.version,
          projects: input.projects,
          upstream_response: upstream,
        },
        audit: { before: null, after: { version: input.version, projects: input.projects } },
        summary: `Sentry release "${input.version}" created.`,
      };
    },
  }, callerHash);
}
