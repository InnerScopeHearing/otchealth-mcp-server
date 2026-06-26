import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { createWorkflow } from '../../n8n/write-client.js';

export function registerN8nCreateWorkflow(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'n8n_create_workflow',
    category: 'write_orchestrated',
    annotations: {
      title: 'Create n8n workflow',
      description:
        'Create a new n8n workflow via the public API. The workflow is created in inactive state. ' +
        'Requires a valid nodes array and connections map. Use n8n_activate_workflow to enable it after creation. ' +
        'Classified write_orchestrated because it provisions new automation infrastructure. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputShape: {
      name: z.string().min(1).describe('Workflow name (unique per n8n instance is recommended).'),
      nodes: z
        .array(z.record(z.unknown()))
        .describe('Array of n8n node objects (type, parameters, position, etc.).'),
      connections: z
        .record(z.unknown())
        .describe('n8n connections map linking node outputs to inputs.'),
      settings: z
        .record(z.unknown())
        .optional()
        .describe('Optional workflow-level settings (e.g. { errorWorkflow, timezone }).'),
      tags: z
        .array(z.object({ name: z.string() }))
        .optional()
        .describe('Optional tags to attach to the workflow for organization.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      workflow_id: z.string().nullable(),
      name: z.string(),
      active: z.boolean().nullable(),
      upstream_result: z.unknown().nullable(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: {
            executed: false,
            dry_run: true,
            workflow_id: null,
            name: input.name,
            active: null,
            upstream_result: null,
          },
          audit: { before: null, after: { name: input.name, node_count: input.nodes.length } },
          summary: `DRY RUN: would create workflow "${input.name}" with ${input.nodes.length} node(s). Pass dry_run=false to apply.`,
        };
      }

      const upstream = await createWorkflow(
        {
          name: input.name,
          nodes: input.nodes,
          connections: input.connections as Record<string, unknown>,
          settings: input.settings,
          tags: input.tags,
        },
        { correlationId: ctx.correlationId },
      );

      const workflowId: string = upstream?.id ?? '';

      return {
        data: {
          executed: true,
          dry_run: false,
          workflow_id: workflowId,
          name: input.name,
          active: upstream?.active ?? false,
          upstream_result: upstream,
        },
        audit: { before: null, after: { workflow_id: workflowId, name: input.name } },
        summary: `Created workflow "${input.name}" (id: ${workflowId}, active: ${upstream?.active ?? false}).`,
      };
    },
  }, callerHash);
}
