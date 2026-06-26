import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { getDashboard } from '../../posthog/full-client.js';

export function registerPostHogDashboardGet(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'posthog_dashboard_get',
    category: 'read',
    annotations: {
      title: 'Get PostHog dashboard',
      description: 'Retrieve a single dashboard by ID (GET /api/projects/{id}/dashboards/{dashboard_id}/). MedReview PHI project 468398 is blocked.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      project_id: z.string().min(1).describe('PostHog numeric project ID. Project 468398 (MedReview PHI) is blocked.'),
      dashboard_id: z.string().min(1).describe('Dashboard numeric ID.'),
    },
    outputShape: {
      dashboard: z.unknown(),
    },
    handler: async (input) => {
      const dashboard = await getDashboard({ project_id: input.project_id, dashboard_id: input.dashboard_id });
      return {
        data: { dashboard },
        summary: `Dashboard ${input.dashboard_id} on project ${input.project_id}.`,
      };
    },
  }, callerHash);
}
