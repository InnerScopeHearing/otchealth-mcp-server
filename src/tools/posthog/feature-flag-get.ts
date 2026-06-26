import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { getFeatureFlag } from '../../posthog/full-client.js';

export function registerPostHogFeatureFlagGet(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'posthog_feature_flag_get',
    category: 'read',
    annotations: {
      title: 'Get PostHog feature flag',
      description: 'Retrieve a single feature flag by ID (GET /api/projects/{id}/feature_flags/{flag_id}/). MedReview PHI project 468398 is blocked.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      project_id: z.string().min(1).describe('PostHog numeric project ID. Project 468398 (MedReview PHI) is blocked.'),
      flag_id: z.string().min(1).describe('Feature flag numeric ID.'),
    },
    outputShape: {
      flag: z.unknown(),
    },
    handler: async (input) => {
      const flag = await getFeatureFlag({ project_id: input.project_id, flag_id: input.flag_id });
      return {
        data: { flag },
        summary: `Feature flag ${input.flag_id} on project ${input.project_id}.`,
      };
    },
  }, callerHash);
}
