import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { updateWorkflowTags } from '../../n8n/full-client.js';

export function registerN8nWorkflowTagsUpdate(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'n8n_workflow_tags_update',
    category: 'write_simple',
    annotations: {
      title: 'Replace tags on an n8n workflow',
      description:
        'Replace the full set of tags on a workflow. This is a full replacement — tags not in the provided list are removed. ' +
        'Pass an empty array to remove all tags. Use n8n_tag_list to get tag IDs. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      workflow_id: z.string().min(1).describe('Workflow ID to update tags on.'),
      tag_ids: z
        .array(z.string())
        .describe('Array of tag IDs to set on the workflow (full replacement). Pass [] to clear all tags.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      workflow_id: z.string(),
      tag_ids: z.array(z.string()),
      upstream_result: z.unknown().nullable(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: {
            executed: false, dry_run: true,
            workflow_id: input.workflow_id,
            tag_ids: input.tag_ids,
            upstream_result: null,
          },
          audit: { before: null, after: input },
          summary: `DRY RUN: would replace tags on workflow ${input.workflow_id} with [${input.tag_ids.join(', ')}]. Pass dry_run=false to apply.`,
        };
      }
      const tagObjects = input.tag_ids.map((id) => ({ id }));
      const upstream = await updateWorkflowTags(input.workflow_id, tagObjects, { correlationId: ctx.correlationId });
      return {
        data: {
          executed: true, dry_run: false,
          workflow_id: input.workflow_id,
          tag_ids: input.tag_ids,
          upstream_result: upstream,
        },
        audit: { before: null, after: { workflow_id: input.workflow_id, tag_ids: input.tag_ids } },
        summary: `Updated tags on workflow ${input.workflow_id} (${input.tag_ids.length} tag(s) set).`,
      };
    },
  }, callerHash);
}
