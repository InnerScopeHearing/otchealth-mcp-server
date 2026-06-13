import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { listCohorts } from '../../posthog/api-client.js';

/**
 * PHI CARVE-OUT: returns cohort DEFINITIONS (name, filters, count) only. It does
 * NOT read cohort MEMBERSHIP (the persons in a cohort), which would be
 * person-level data. See src/posthog/api-client.ts header.
 */
export function registerPosthogListCohorts(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(
    server,
    {
      name: 'posthog_list_cohorts',
      category: 'read',
      annotations: {
        title: 'List PostHog cohorts',
        description:
          'List cohort definitions for a project (name, filter groups, member count). Definitions only; never reads the persons in a cohort (no person-level data through this gateway).',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputShape: {
        project_id: z.union([z.string(), z.number()]),
        limit: z.number().int().min(1).max(100).optional(),
        offset: z.number().int().min(0).optional(),
      },
      outputShape: {
        cohorts: z.array(z.unknown()),
        count: z.number().nullable(),
      },
      handler: async (input, ctx) => {
        const query: Record<string, string | number | undefined> = {};
        if (input.limit !== undefined) query.limit = input.limit;
        if (input.offset !== undefined) query.offset = input.offset;
        const data = await listCohorts(input.project_id, { query, correlationId: ctx.correlationId });
        const cohorts = data.results ?? [];
        return {
          data: { cohorts, count: data.count ?? null },
          summary: `Found ${cohorts.length} cohort(s) on this page.`,
        };
      },
    },
    callerHash,
  );
}
