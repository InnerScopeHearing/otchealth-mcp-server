import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { getBuildStepLogs } from '../../depot/full-client.js';

export function registerDepotBuildStepLogsGet(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'depot_build_step_logs_get',
    category: 'read',
    annotations: {
      title: 'Depot: get build step logs',
      description: 'Get logs for a specific BuildKit step in a Depot container build. Useful for diagnosing slow or failing layers. Read-only.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      build_id: z.string().describe('The Depot build ID.'),
      step_id: z.string().describe('The build step ID (from depot_build_steps_get).'),
    },
    outputShape: {
      logs: z.unknown(),
    },
    handler: async (input) => {
      const result = await getBuildStepLogs({
        buildId: input.build_id,
        stepId: input.step_id,
      });
      return {
        data: { logs: result },
        summary: `Logs for build ${input.build_id} step ${input.step_id}.`,
      };
    },
  }, callerHash);
}
