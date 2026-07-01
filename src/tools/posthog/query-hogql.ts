import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { queryHogQL } from '../../posthog/full-client.js';

export function registerPostHogQueryHogQL(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'posthog_query_hogql',
    category: 'read',
    annotations: {
      title: 'Query PostHog via HogQL',
      description: 'Execute a HogQL (SQL-compatible) query against a PostHog project (POST /api/projects/{id}/query/). Returns tabular results. MedReview PHI project 468398 is blocked.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      project_id: z.string().min(1).describe('PostHog numeric project ID. Project 468398 (MedReview PHI) is blocked.'),
      query: z.string().min(1).describe('HogQL query string, e.g. "SELECT event, count() FROM events GROUP BY event LIMIT 10".'),
      limit: z.number().int().positive().optional().describe('Override result limit in the query node (optional).'),
    },
    outputShape: {
      columns: z.array(z.string()),
      results: z.array(z.unknown()),
      hogql: z.string().optional(),
    },
    handler: async (input) => {
      const data = await queryHogQL({ project_id: input.project_id, query: input.query, limit: input.limit });
      const columns: string[] = Array.isArray(data?.columns) ? data.columns : [];
      const results: unknown[] = Array.isArray(data?.results) ? data.results : [];
      return {
        data: { columns, results, hogql: data?.hogql },
        summary: `HogQL query returned ${results.length} row(s) on project ${input.project_id}.`,
      };
    },
  }, callerHash);
}
