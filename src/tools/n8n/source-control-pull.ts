import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { pullSourceControl } from '../../n8n/full-client.js';

export function registerN8nSourceControlPull(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'n8n_source_control_pull',
    category: 'write_orchestrated',
    annotations: {
      title: 'Pull n8n source control',
      description:
        'Pull the latest workflow/credential definitions from the configured source-control branch (Git) into the n8n instance. ' +
        'This overwrites the live workflow state with what is in source control. Requires source control to be configured in n8n Settings. ' +
        'Classified write_orchestrated because it performs a production deploy of automation definitions. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputShape: {
      force: z
        .boolean()
        .optional()
        .describe('If true, overwrite local changes even if there are conflicts (default: false).'),
      variables: z
        .record(z.string())
        .optional()
        .describe('Optional variable overrides to apply during the pull (key-value string map).'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      force: z.boolean(),
      upstream_result: z.unknown().nullable(),
    },
    handler: async (input, ctx) => {
      const force = input.force ?? false;
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, force, upstream_result: null },
          audit: { before: null, after: { force, variables: input.variables } },
          summary: `DRY RUN: would pull source control (force=${force}). Pass dry_run=false to apply.`,
        };
      }
      const upstream = await pullSourceControl({
        force,
        variables: input.variables,
        correlationId: ctx.correlationId,
      });
      return {
        data: { executed: true, dry_run: false, force, upstream_result: upstream },
        audit: { before: null, after: { force, variables: input.variables } },
        summary: `Source control pull complete (force=${force}).`,
      };
    },
  }, callerHash);
}
