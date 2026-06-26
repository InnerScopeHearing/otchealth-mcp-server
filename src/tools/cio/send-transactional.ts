import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { sendTransactional } from '../../customerio/write-client.js';

export function registerSendTransactional(
  server: McpServer,
  callerHash: CallerHashProvider,
): void {
  registerTool(
    server,
    {
      name: 'cio_send_transactional',
      category: 'write_orchestrated',
      annotations: {
        title: 'Send Customer.io transactional email (App API)',
        description:
          'Sends a transactional email via Customer.io App API POST /v1/send/email using a ' +
          'pre-built transactional message template. Unlike broadcast campaigns this sends to a ' +
          'single recipient per call but bypasses suppression by default — use carefully. ' +
          'Requires a valid transactional_message_id from the Customer.io workspace. Defaults to dry_run.',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      inputShape: {
        transactional_message_id: z
          .union([z.string(), z.number()])
          .describe(
            'ID (integer) or name (string) of the transactional message template in Customer.io.',
          ),
        to: z
          .string()
          .email()
          .describe('Recipient email address.'),
        identifier_email: z
          .string()
          .email()
          .optional()
          .describe(
            'Email address used to look up the Customer.io profile. ' +
            'Typically the same as "to". Used in identifiers.email.',
          ),
        identifier_id: z
          .string()
          .optional()
          .describe(
            'Workspace customer id used to look up the Customer.io profile (alternative to identifier_email).',
          ),
        message_data: z
          .record(z.unknown())
          .optional()
          .describe(
            'Liquid template variables merged into the transactional message at send time.',
          ),
        subject: z
          .string()
          .optional()
          .describe('Override the template subject line.'),
        from: z
          .string()
          .optional()
          .describe('Sender email address. Defaults to the template "from" setting.'),
        reply_to: z
          .string()
          .optional()
          .describe('Reply-to email address override.'),
        bcc: z
          .string()
          .optional()
          .describe('BCC email address.'),
        send_to_unsubscribed: z
          .boolean()
          .optional()
          .describe(
            'If true, sends even if the recipient is unsubscribed. Use only for mandatory transactionals (e.g. receipts, password resets). Default false.',
          ),
        queue_draft: z
          .boolean()
          .optional()
          .describe('If true, queues a draft instead of sending immediately. Default false.'),
      },
      outputShape: {
        executed: z.boolean(),
        dry_run: z.boolean(),
        to: z.string(),
        transactional_message_id: z.union([z.string(), z.number()]),
        delivery_id: z.string().nullable(),
        queued_at: z.number().nullable(),
      },
      handler: async (input, ctx) => {
        if (ctx.dryRun) {
          return {
            data: {
              executed: false,
              dry_run: true,
              to: input.to,
              transactional_message_id: input.transactional_message_id,
              delivery_id: null,
              queued_at: null,
            },
            audit: { before: null, after: input },
            summary:
              `DRY RUN: would send transactional message ${input.transactional_message_id} to ${input.to}. ` +
              'Pass dry_run=false to send.',
          };
        }

        const identifiers: { email?: string; id?: string } = {};
        if (input.identifier_email) identifiers.email = input.identifier_email;
        else if (input.identifier_id) identifiers.id = input.identifier_id;
        else identifiers.email = input.to;

        const upstream = await sendTransactional({
          transactional_message_id: input.transactional_message_id,
          to: input.to,
          identifiers,
          message_data: input.message_data,
          subject: input.subject,
          from: input.from,
          reply_to: input.reply_to,
          bcc: input.bcc,
          send_to_unsubscribed: input.send_to_unsubscribed,
          queue_draft: input.queue_draft,
          correlationId: ctx.correlationId,
        });

        return {
          data: {
            executed: true,
            dry_run: false,
            to: input.to,
            transactional_message_id: input.transactional_message_id,
            delivery_id: upstream.delivery_id ?? null,
            queued_at: upstream.queued_at ?? null,
          },
          audit: { before: null, after: input },
          summary: `Transactional email ${upstream.delivery_id} queued for ${input.to}.`,
        };
      },
    },
    callerHash,
  );
}
