import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { getAttempt } from '../../depot/full-client.js';

export function registerDepotAttemptGet(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'depot_attempt_get',
    category: 'read',
    annotations: {
      title: 'Depot CI: get job attempt',
      description: 'Get details of a specific Depot CI job attempt including status, sandbox/session IDs, and full parent context. Read-only.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      attempt_id: z.string().describe('The Depot CI attempt ID.'),
    },
    outputShape: {
      attempt: z.unknown(),
    },
    handler: async (input) => {
      const result = await getAttempt({ attemptId: input.attempt_id });
      return {
        data: { attempt: result },
        summary: `Attempt ${input.attempt_id}: status=${result?.attemptStatus ?? result?.status}.`,
      };
    },
  }, callerHash);
}
