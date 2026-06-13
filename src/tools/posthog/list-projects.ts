import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { listProjects } from '../../posthog/api-client.js';

/**
 * PHI CARVE-OUT: this returns project METADATA only (id, name, config flags).
 * It will include the PHI-hardened MedReview project (468398), but only its
 * metadata. No replay / recording / person-data is ever exposed. See
 * src/posthog/api-client.ts header.
 */
export function registerPosthogListProjects(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(
    server,
    {
      name: 'posthog_list_projects',
      category: 'read',
      annotations: {
        title: 'List PostHog projects',
        description:
          'List PostHog projects (metadata only: id, name, config flags). Use a project id with the other PostHog tools. Includes the PHI-hardened MedReview project (468398) as metadata only; no replay/recording/person data is ever exposed through this gateway.',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputShape: {
        limit: z.number().int().min(1).max(200).optional(),
        offset: z.number().int().min(0).optional(),
      },
      outputShape: {
        projects: z.array(z.unknown()),
        count: z.number().nullable(),
      },
      handler: async (input, ctx) => {
        const query: Record<string, string | number | undefined> = {};
        if (input.limit !== undefined) query.limit = input.limit;
        if (input.offset !== undefined) query.offset = input.offset;
        const data = await listProjects({ query, correlationId: ctx.correlationId });
        const projects = data.results ?? [];
        return {
          data: { projects, count: data.count ?? null },
          summary: `Found ${projects.length} PostHog project(s) on this page.`,
        };
      },
    },
    callerHash,
  );
}
