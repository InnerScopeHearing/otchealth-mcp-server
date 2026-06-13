import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { listExperiments } from '../../posthog/api-client.js';

export function registerPosthogListExperiments(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(
    server,
    {
      name: 'posthog_list_experiments',
      category: 'read',
      annotations: {
        title: 'List PostHog experiments',
        description:
          'List A/B experiments for a project (name, feature-flag key, start/end, status, metrics). Metadata only.',
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
        experiments: z.array(z.unknown()),
        count: z.number().nullable(),
      },
      handler: async (input, ctx) => {
        const query: Record<string, string | number | undefined> = {};
        if (input.limit !== undefined) query.limit = input.limit;
        if (input.offset !== undefined) query.offset = input.offset;
        const data = await listExperiments(input.project_id, { query, correlationId: ctx.correlationId });
        const experiments = data.results ?? [];
        return {
          data: { experiments, count: data.count ?? null },
          summary: `Found ${experiments.length} experiment(s) on this page.`,
        };
      },
    },
    callerHash,
  );
}
