import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { listFeatureFlags } from '../../posthog/api-client.js';

export function registerPosthogListFeatureFlags(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(
    server,
    {
      name: 'posthog_list_feature_flags',
      category: 'read',
      annotations: {
        title: 'List PostHog feature flags',
        description:
          'List feature flags for a project (key, name, active, rollout %, release conditions). Metadata only. Relevant to the portfolio REPLAY_LOCKDOWN and gradual-rollout flags.',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputShape: {
        project_id: z.union([z.string(), z.number()]),
        limit: z.number().int().min(1).max(100).optional(),
        offset: z.number().int().min(0).optional(),
        active: z.boolean().optional().describe('Filter to active=true / inactive=false flags.'),
        search: z.string().optional(),
      },
      outputShape: {
        feature_flags: z.array(z.unknown()),
        count: z.number().nullable(),
      },
      handler: async (input, ctx) => {
        const query: Record<string, string | number | boolean | undefined> = {};
        if (input.limit !== undefined) query.limit = input.limit;
        if (input.offset !== undefined) query.offset = input.offset;
        if (input.active !== undefined) query.active = input.active;
        if (input.search !== undefined) query.search = input.search;
        const data = await listFeatureFlags(input.project_id, { query, correlationId: ctx.correlationId });
        const flags = data.results ?? [];
        return {
          data: { feature_flags: flags, count: data.count ?? null },
          summary: `Found ${flags.length} feature flag(s) on this page.`,
        };
      },
    },
    callerHash,
  );
}
