import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { resetCache } from '../../depot/api-client.js';

/**
 * GUARDED WRITE (destructive): purge / reset a Depot project's build cache.
 * Gated behind ENABLE_WRITE_TOOLS (category 'write_simple' -> blocked by
 * READ_ONLY_MODE and ENABLE_WRITE_TOOLS=false by default; see registry.ts).
 * Destructive because the next build after a reset is a cold (slow) build.
 * Defaults to dry_run.
 */
export function registerDepotResetCache(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(
    server,
    {
      name: 'depot_reset_cache',
      category: 'write_simple',
      annotations: {
        title: 'Reset a Depot project build cache (destructive)',
        description:
          'Purge a Depot project build cache. DESTRUCTIVE: the next build runs cold (slower). Gated behind ENABLE_WRITE_TOOLS; defaults to dry_run.',
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputShape: {
        project_id: z.string().optional().describe('Depot project id. Defaults to DEPOT_PROJECT_ID if unset.'),
      },
      outputShape: {
        executed: z.boolean(),
        dry_run: z.boolean(),
        project_id: z.string().nullable(),
        result: z.unknown().nullable(),
        source_rpc: z.string().nullable(),
      },
      handler: async (input, ctx) => {
        if (ctx.dryRun) {
          return {
            data: {
              executed: false,
              dry_run: true,
              project_id: input.project_id ?? null,
              result: null,
              source_rpc: null,
            },
            audit: { before: { cache: 'present' }, after: { cache: 'would_be_reset' } },
            summary: 'DRY RUN: no cache reset performed. Pass dry_run=false (and ENABLE_WRITE_TOOLS=true) to execute.',
          };
        }
        const { result, source_rpc } = await resetCache(
          { projectId: input.project_id },
          { correlationId: ctx.correlationId },
        );
        return {
          data: {
            executed: true,
            dry_run: false,
            project_id: input.project_id ?? null,
            result,
            source_rpc,
          },
          audit: { before: { cache: 'present' }, after: { cache: 'reset' } },
        };
      },
    },
    callerHash,
  );
}
