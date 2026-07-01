import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { getJob } from '../../depot/full-client.js';

export function registerDepotJobGet(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'depot_job_get',
    category: 'read',
    annotations: {
      title: 'Depot CI: get job',
      description: 'Get full details of a Depot CI job including status, runner config, dependencies, and attempt history. Read-only.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      job_id: z.string().describe('The Depot CI job ID.'),
    },
    outputShape: {
      job: z.unknown(),
    },
    handler: async (input) => {
      const result = await getJob({ jobId: input.job_id });
      return {
        data: { job: result },
        summary: `Job ${input.job_id}: key=${result?.jobKey}, status=${result?.jobStatus}.`,
      };
    },
  }, callerHash);
}
