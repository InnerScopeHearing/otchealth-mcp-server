import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { runWorkflow } from '../../n8n/write-client.js';

export function registerN8nRunWorkflow(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'n8n_run_workflow',
    category: 'write_simple',
    annotations: {
      title: 'Run n8n workflow via webhook',
      description:
        'Trigger an n8n workflow by POSTing a signed payload to its webhook URL. ' +
        'The webhook must be active and the workflow must expose a Webhook node. ' +
        'Response is the JSON returned by the workflow\'s respondToWebhook node. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputShape: {
      webhook_path: z
        .string()
        .min(1)
        .describe('Webhook path registered on the workflow, e.g. "/webhook/my-workflow". Must start with /.'),
      payload: z
        .record(z.unknown())
        .describe('JSON payload to send to the workflow.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      webhook_path: z.string(),
      success: z.boolean().nullable(),
      result: z.unknown().nullable(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: {
            executed: false,
            dry_run: true,
            webhook_path: input.webhook_path,
            success: null,
            result: null,
          },
          audit: { before: null, after: input },
          summary: `DRY RUN: would POST to webhook ${input.webhook_path} with payload keys: [${Object.keys(input.payload).join(', ')}]. Pass dry_run=false to apply.`,
        };
      }

      const upstream = await runWorkflow({
        webhookPath: input.webhook_path,
        payload: input.payload,
        toolName: 'n8n_run_workflow',
        callerHash: ctx.callerHash,
        correlationId: ctx.correlationId,
      });

      return {
        data: {
          executed: true,
          dry_run: false,
          webhook_path: input.webhook_path,
          success: upstream.success,
          result: upstream.result ?? null,
        },
        audit: { before: null, after: input },
        summary: `Triggered webhook ${input.webhook_path} — success: ${upstream.success}.`,
      };
    },
  }, callerHash);
}
