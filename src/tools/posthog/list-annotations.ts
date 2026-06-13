import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { listAnnotations } from '../../posthog/api-client.js';

export function registerPosthogListAnnotations(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(
    server,
    {
      name: 'posthog_list_annotations',
      category: 'read',
      annotations: {
        title: 'List PostHog annotations',
        description:
          'List annotations for a project (release markers, deploy notes on charts). Metadata only. Useful to correlate build/release events with metric movement.',
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
        annotations: z.array(z.unknown()),
        count: z.number().nullable(),
      },
      handler: async (input, ctx) => {
        const query: Record<string, string | number | undefined> = {};
        if (input.limit !== undefined) query.limit = input.limit;
        if (input.offset !== undefined) query.offset = input.offset;
        const data = await listAnnotations(input.project_id, { query, correlationId: ctx.correlationId });
        const annotations = data.results ?? [];
        return {
          data: { annotations, count: data.count ?? null },
          summary: `Found ${annotations.length} annotation(s) on this page.`,
        };
      },
    },
    callerHash,
  );
}
