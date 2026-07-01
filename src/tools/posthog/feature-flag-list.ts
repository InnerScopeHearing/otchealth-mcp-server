import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { listFeatureFlags } from '../../posthog/full-client.js';

export function registerPostHogFeatureFlagList(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'posthog_feature_flag_list',
    category: 'read',
    annotations: {
      title: 'List PostHog feature flags',
      description: 'List all feature flags for a PostHog project (GET /api/projects/{id}/feature_flags/). MedReview PHI project 468398 is blocked.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      project_id: z.string().min(1).describe('PostHog numeric project ID. Project 468398 (MedReview PHI) is blocked.'),
      limit: z.number().int().positive().optional().describe('Max results to return.'),
      offset: z.number().int().min(0).optional().describe('Pagination offset.'),
    },
    outputShape: {
      results: z.array(z.unknown()),
      count: z.number(),
    },
    handler: async (input) => {
      const data = await listFeatureFlags({ project_id: input.project_id, limit: input.limit, offset: input.offset });
      const results = Array.isArray(data?.results) ? data.results : (Array.isArray(data) ? data : []);
      return {
        data: { results, count: data?.count ?? results.length },
        summary: `${results.length} feature flag(s) on project ${input.project_id}.`,
      };
    },
  }, callerHash);
}
