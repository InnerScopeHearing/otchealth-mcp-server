import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { getRunStatus } from '../../depot/full-client.js';

export function registerDepotRunStatusGet(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'depot_run_status_get',
    category: 'read',
    annotations: {
      title: 'Depot CI: get run status (full)',
      description: 'Get a Depot CI run\'s full status including nested workflows, jobs, and attempt states. Use this to poll an in-flight run. Read-only.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      run_id: z.string().describe('The Depot CI run ID.'),
    },
    outputShape: {
      run_id: z.string().optional(),
      status: z.string().optional(),
      workflows: z.array(z.unknown()).optional(),
    },
    handler: async (input) => {
      const result = await getRunStatus({ runId: input.run_id });
      return {
        data: {
          run_id: result?.runId,
          status: result?.status,
          workflows: result?.workflows ?? [],
        },
        summary: `Run ${input.run_id} status: ${result?.status}. ${result?.workflows?.length ?? 0} workflow(s).`,
      };
    },
  }, callerHash);
}
