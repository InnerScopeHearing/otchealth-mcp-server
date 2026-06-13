import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { getInsight } from '../../posthog/api-client.js';

export function registerPosthogGetInsight(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(
    server,
    {
      name: 'posthog_get_insight',
      category: 'read',
      annotations: {
        title: 'Get a PostHog insight',
        description:
          'Fetch a single insight (funnel/trend) definition + its last-computed result metadata. Returns aggregate insight data only, never raw person-level event rows.',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputShape: {
        project_id: z.union([z.string(), z.number()]),
        insight_id: z.union([z.string(), z.number()]),
      },
      outputShape: {
        insight: z.unknown(),
      },
      handler: async (input, ctx) => {
        const insight = await getInsight(input.project_id, input.insight_id, { correlationId: ctx.correlationId });
        return { data: { insight } };
      },
    },
    callerHash,
  );
}
