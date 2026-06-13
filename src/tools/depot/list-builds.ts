import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { listBuilds } from '../../depot/api-client.js';

export function registerDepotListBuilds(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(
    server,
    {
      name: 'depot_list_builds',
      category: 'read',
      annotations: {
        title: 'List Depot builds',
        description:
          'List builds for a Depot project (defaults to DEPOT_PROJECT_ID if project_id is omitted). Optional status filter (e.g. running, finished, failed) is applied to the returned page. Returns buildId, status, and timestamps.',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputShape: {
        project_id: z.string().optional().describe('Depot project id. Defaults to DEPOT_PROJECT_ID if unset.'),
        status: z
          .string()
          .optional()
          .describe('Case-insensitive substring filter on build status (e.g. running, finished, failed, queued).'),
        page_size: z.number().int().min(1).max(250).optional(),
        page_token: z.string().optional().describe('Pagination token from a previous response.'),
      },
      outputShape: {
        builds: z.array(z.unknown()),
        count: z.number(),
        next_page_token: z.string().nullable(),
      },
      handler: async (input, ctx) => {
        const { builds, nextPageToken } = await listBuilds(
          {
            projectId: input.project_id,
            status: input.status,
            pageSize: input.page_size,
            pageToken: input.page_token,
          },
          { correlationId: ctx.correlationId },
        );
        return {
          data: { builds, count: builds.length, next_page_token: nextPageToken },
          summary: `Found ${builds.length} build(s)${input.status ? ` matching status "${input.status}"` : ''}.`,
        };
      },
    },
    callerHash,
  );
}
