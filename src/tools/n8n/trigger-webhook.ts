import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { callN8nWebhook } from '../../n8n/webhook-client.js';

export function registerN8nTriggerWebhook(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(
    server,
    {
      name: 'n8n_trigger_webhook',
      category: 'write_simple',
      annotations: {
        title: 'n8n: trigger workflow webhook',
        description: 'Fire an n8n workflow by its webhook path with an HMAC-signed JSON payload — the way to kick off an automation (e.g. route a new lead into the phone/lifecycle flow). Honors dry_run (plan-only by default).',
        readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true,
      },
      inputShape: {
        webhook_path: z.string().describe('Webhook path, e.g. "/webhook/lead-intake". Must start with /webhook/.'),
        payload: z.record(z.unknown()).optional().describe('JSON payload to send to the workflow.'),
      },
      outputShape: { success: z.boolean().optional(), result: z.unknown().optional(), planned: z.boolean().optional() },
      handler: async (input, ctx) => {
        const path = input.webhook_path.startsWith('/') ? input.webhook_path : `/${input.webhook_path}`;
        if (ctx.dryRun) return { data: { planned: true }, summary: `DRY RUN: would POST to n8n webhook ${path}. Pass dry_run=false to fire.` };
        const r = await callN8nWebhook({ webhookPath: path, payload: input.payload ?? {}, toolName: 'n8n_trigger_webhook', callerHash: ctx.callerHash, correlationId: ctx.correlationId });
        return { data: { success: r.success, result: r.result }, summary: `Triggered n8n webhook ${path} (success=${r.success}).`, audit: { after: { webhook: path } } };
      },
    },
    callerHash,
  );
}
