import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { getFeatureFlag } from '../../posthog/api-client.js';

export function registerPosthogGetFeatureFlag(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(
    server,
    {
      name: 'posthog_get_feature_flag',
      category: 'read',
      annotations: {
        title: 'Get a PostHog feature flag',
        description:
          'Fetch a single feature flag definition (key, filters, rollout %, variants, release conditions). Metadata only.',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputShape: {
        project_id: z.union([z.string(), z.number()]),
        flag_id: z.union([z.string(), z.number()]),
      },
      outputShape: {
        feature_flag: z.unknown(),
      },
      handler: async (input, ctx) => {
        const flag = await getFeatureFlag(input.project_id, input.flag_id, { correlationId: ctx.correlationId });
        return { data: { feature_flag: flag } };
      },
    },
    callerHash,
  );
}
