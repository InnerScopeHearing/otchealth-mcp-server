import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { updateWorkflow } from '../../n8n/write-client.js';

export function registerN8nUpdateWorkflow(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'n8n_update_workflow',
    category: 'write_orchestrated',
    annotations: {
      title: 'Update n8n workflow',
      description:
        'Full replacement of an n8n workflow definition (PUT). All fields — nodes, connections, settings — ' +
        'are replaced atomically. Fetch the current definition first with the n8n API before editing. ' +
        'Classified write_orchestrated because modifying live automation infrastructure is high-risk. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      workflow_id: z.string().min(1).describe('The n8n workflow ID to update (from n8n_list_workflows).'),
      name: z.string().min(1).describe('Workflow name (may be unchanged from current).'),
      nodes: z
        .array(z.record(z.unknown()))
        .describe('Full replacement array of n8n node objects.'),
      connections: z
        .record(z.unknown())
        .describe('Full replacement n8n connections map.'),
      settings: z
        .record(z.unknown())
        .optional()
        .describe('Optional workflow-level settings override.'),
      tags: z
        .array(z.object({ name: z.string() }))
        .optional()
        .describe('Optional tags to attach (replaces existing tags).'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      workflow_id: z.string(),
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
            workflow_id: input.workflow_id,
            name: input.name,
            active: null,
            upstream_result: null,
          },
          audit: { before: null, after: { workflow_id: input.workflow_id, name: input.name, node_count: input.nodes.length } },
          summary: `DRY RUN: would PUT workflow ${input.workflow_id} ("${input.name}") with ${input.nodes.length} node(s). Pass dry_run=false to apply.`,
        };
      }

      const upstream = await updateWorkflow(
        input.workflow_id,
        {
          name: input.name,
          nodes: input.nodes,
          connections: input.connections as Record<string, unknown>,
          settings: input.settings,
          tags: input.tags,
        },
        { correlationId: ctx.correlationId },
      );

      return {
        data: {
          executed: true,
          dry_run: false,
          workflow_id: input.workflow_id,
          name: input.name,
          active: upstream?.active ?? null,
          upstream_result: upstream,
        },
        audit: { before: null, after: { workflow_id: input.workflow_id, name: input.name } },
        summary: `Updated workflow ${input.workflow_id} ("${input.name}").`,
      };
    },
  }, callerHash);
}
