import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { getBuild } from '../../depot/api-client.js';

export function registerDepotGetBuild(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(
    server,
    {
      name: 'depot_get_build',
      category: 'read',
      annotations: {
        title: 'Get a Depot build',
        description:
          'Fetch a single Depot build by id (status + timings + any logs summary the API returns). Optionally scope to a project_id (defaults to DEPOT_PROJECT_ID).',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputShape: {
        build_id: z.string().min(1),
        project_id: z.string().optional().describe('Depot project id. Defaults to DEPOT_PROJECT_ID if unset.'),
      },
      outputShape: {
        build: z.unknown(),
      },
      handler: async (input, ctx) => {
        const { build } = await getBuild(input.build_id, input.project_id, { correlationId: ctx.correlationId });
        return { data: { build } };
      },
    },
    callerHash,
  );
}
