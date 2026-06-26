import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { listRuns } from '../../depot/full-client.js';

export function registerDepotRunList(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'depot_run_list',
    category: 'read',
    annotations: {
      title: 'Depot CI: list runs',
      description: 'List Depot CI runs for the organization, newest first. Filter by status, repo, SHA, trigger, or PR number. Read-only.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      status: z.array(z.enum(['queued', 'running', 'finished', 'failed', 'cancelled'])).optional().describe('Filter by run status. Default: ["running","queued"].'),
      repo: z.string().optional().describe('Filter by GitHub repo in "owner/name" format.'),
      sha: z.string().optional().describe('Filter by commit SHA prefix (1-40 hex chars).'),
      trigger: z.string().optional().describe('Filter by trigger event: push, pull_request, schedule, workflow_dispatch, etc.'),
      pr: z.string().optional().describe('PR number to filter (requires repo).'),
      page_size: z.number().optional().describe('Runs per page, max 100. Default 50.'),
      page_token: z.string().optional().describe('Pagination token from prior response.'),
    },
    outputShape: {
      runs: z.array(z.unknown()),
      count: z.number(),
      next_page_token: z.string().optional(),
    },
    handler: async (input) => {
      const result = await listRuns({
        status: input.status,
        repo: input.repo,
        sha: input.sha,
        trigger: input.trigger,
        pr: input.pr,
        pageSize: input.page_size,
        pageToken: input.page_token,
      });
      const runs = result?.runs ?? [];
      return {
        data: { runs, count: runs.length, next_page_token: result?.nextPageToken },
        summary: `${runs.length} CI run(s) returned.`,
      };
    },
  }, callerHash);
}
