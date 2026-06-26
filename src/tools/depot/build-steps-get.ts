import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { getBuildSteps } from '../../depot/full-client.js';

export function registerDepotBuildStepsGet(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'depot_build_steps_get',
    category: 'read',
    annotations: {
      title: 'Depot: get build steps',
      description: 'Get the BuildKit steps (layers, timing) for a Depot container build. Read-only.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      build_id: z.string().describe('The Depot build ID.'),
    },
    outputShape: {
      steps: z.array(z.unknown()),
      count: z.number(),
    },
    handler: async (input) => {
      const result = await getBuildSteps({ buildId: input.build_id });
      const steps = result?.steps ?? [];
      return {
        data: { steps, count: steps.length },
        summary: `${steps.length} build step(s) for build ${input.build_id}.`,
      };
    },
  }, callerHash);
}
