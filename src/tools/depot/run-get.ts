import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { getRun } from '../../depot/full-client.js';

export function registerDepotRunGet(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'depot_run_get',
    category: 'read',
    annotations: {
      title: 'Depot CI: get run',
      description: 'Get identity, repo, trigger, status, and timestamps for a Depot CI run. For nested workflow/job status use depot_run_status_get. Read-only.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      run_id: z.string().describe('The Depot CI run ID.'),
    },
    outputShape: {
      run: z.unknown(),
    },
    handler: async (input) => {
      const result = await getRun({ runId: input.run_id });
      return {
        data: { run: result },
        summary: `Run ${input.run_id}: status=${result?.status}.`,
      };
    },
  }, callerHash);
}
