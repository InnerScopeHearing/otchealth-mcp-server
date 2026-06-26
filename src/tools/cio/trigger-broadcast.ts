import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { triggerBroadcast } from '../../customerio/write-client.js';

export function registerTriggerBroadcast(
  server: McpServer,
  callerHash: CallerHashProvider,
): void {
  registerTool(
    server,
    {
      name: 'cio_trigger_broadcast',
      category: 'write_orchestrated',
      annotations: {
        title: 'Trigger Customer.io broadcast campaign (App API)',
        description:
          'Triggers a broadcast campaign send via Customer.io App API POST /v1/campaigns/{id}/triggers. ' +
          'This initiates a MASS SEND to all recipients in the campaign audience or a specified segment. ' +
          'Irreversible once triggered. Requires the campaign to be in "draft" or "scheduled" state. ' +
          'This is a high-risk orchestrated operation — requires ENABLE_HIGH_RISK_TOOLS. Defaults to dry_run.',
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
      inputShape: {
        campaign_id: z
          .number()
          .int()
          .positive()
          .describe('Numeric ID of the Customer.io broadcast campaign to trigger.'),
        data: z
          .record(z.unknown())
          .optional()
          .describe(
            'Liquid template variables made available to the campaign content at send time.',
          ),
        recipient_segment_id: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            'Restrict the send to this Customer.io segment ID instead of the campaign\'s default audience.',
          ),
        recipient_emails: z
          .array(z.string().email())
          .optional()
          .describe(
            'Restrict the send to this explicit list of email addresses (max varies by plan). ' +
            'Mutually exclusive with recipient_segment_id.',
          ),
      },
      outputShape: {
        executed: z.boolean(),
        dry_run: z.boolean(),
        campaign_id: z.number(),
        trigger_id: z.number().nullable(),
        upstream_response: z.unknown().nullable(),
      },
      handler: async (input, ctx) => {
        if (ctx.dryRun) {
          return {
            data: {
              executed: false,
              dry_run: true,
              campaign_id: input.campaign_id,
              trigger_id: null,
              upstream_response: null,
            },
            audit: { before: null, after: input },
            summary:
              `DRY RUN: would trigger broadcast campaign ${input.campaign_id} — MASS SEND to the campaign audience. ` +
              'This is irreversible once fired. Pass dry_run=false to trigger.',
          };
        }

        const recipients: { segment?: { id: number }; emails?: string[] } | undefined =
          input.recipient_segment_id !== undefined
            ? { segment: { id: input.recipient_segment_id } }
            : input.recipient_emails !== undefined
            ? { emails: input.recipient_emails }
            : undefined;

        const upstream = await triggerBroadcast({
          campaign_id: input.campaign_id,
          data: input.data,
          recipients,
          correlationId: ctx.correlationId,
        });

        return {
          data: {
            executed: true,
            dry_run: false,
            campaign_id: input.campaign_id,
            trigger_id: upstream.id ?? null,
            upstream_response: upstream,
          },
          audit: { before: null, after: input },
          summary: `Broadcast campaign ${input.campaign_id} triggered (trigger id: ${upstream.id}).`,
        };
      },
    },
    callerHash,
  );
}
