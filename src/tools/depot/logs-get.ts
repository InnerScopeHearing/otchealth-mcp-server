import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { getJobAttemptLogs } from '../../depot/full-client.js';

export function registerDepotLogsGet(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'depot_logs_get',
    category: 'read',
    annotations: {
      title: 'Depot CI: get job attempt logs',
      description: 'Get persisted log lines for a Depot CI job attempt (oldest first). Paginate with page_token. Use job_id to get logs for the job\'s latest attempt. Read-only.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      attempt_id: z.string().optional().describe('The attempt ID whose logs to fetch. Required unless job_id is set.'),
      job_id: z.string().optional().describe('Job ID — fetches logs for its latest attempt. Required unless attempt_id is set.'),
      page_token: z.string().optional().describe('Pagination token from a prior response to fetch the next batch of lines.'),
    },
    outputShape: {
      logs: z.unknown(),
    },
    handler: async (input) => {
      const result = await getJobAttemptLogs({
        attemptId: input.attempt_id,
        jobId: input.job_id,
        pageToken: input.page_token,
      });
      return {
        data: { logs: result },
        summary: `Log lines fetched for ${input.attempt_id ? `attempt ${input.attempt_id}` : `job ${input.job_id} (latest attempt)`}.`,
      };
    },
  }, callerHash);
}
