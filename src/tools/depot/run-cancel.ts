import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { cancelRun } from '../../depot/full-client.js';

export function registerDepotRunCancel(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'depot_run_cancel',
    category: 'write_orchestrated',
    annotations: {
      title: 'Depot CI: cancel run',
      description: 'Cancel a queued or running Depot CI run including all its unfinished workflows and jobs. Defaults to dry_run. CTO-only (terminates compute).',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputShape: {
      run_id: z.string().describe('The Depot CI run ID to cancel.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      run_id: z.string().optional(),
      status: z.string().optional(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, run_id: input.run_id },
          audit: { before: null, after: input },
          summary: `DRY RUN: would cancel Depot CI run ${input.run_id}. Pass dry_run=false to apply.`,
        };
      }
      const result = await cancelRun({ runId: input.run_id });
      return {
        data: { executed: true, dry_run: false, run_id: result?.runId, status: result?.status },
        audit: { before: null, after: result },
        summary: `Cancelled Depot CI run ${input.run_id}. Status: ${result?.status}.`,
      };
    },
  }, callerHash);
}
