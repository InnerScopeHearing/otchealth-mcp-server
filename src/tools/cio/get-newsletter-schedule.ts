import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { appApiGet } from '../../customerio/app-api-client.js';

interface NewsletterRecord {
  id?: number | string;
  name?: string;
  state?: string;
  status?: string;
  send_at?: number | null;
  scheduled_at?: number | null;
  original_scheduled_at?: number | null;
  recurring?: unknown;
  start_at?: number | null;
  next_send_at?: number | null;
  timezone?: string | null;
  [k: string]: unknown;
}

export function registerGetNewsletterSchedule(
  server: McpServer,
  callerHash: CallerHashProvider,
): void {
  registerTool(
    server,
    {
      name: 'cio_get_newsletter_schedule',
      category: 'read',
      annotations: {
        title: 'Get a Customer.io newsletter schedule',
        description:
          'Authoritative send-schedule info for a newsletter: scheduled_at, original_scheduled_at, send_at, state, recurring config when present. Sourced from the newsletter record (Customer.io does not expose a dedicated /schedule endpoint).',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputShape: {
        newsletter_id: z
          .union([z.string(), z.number()])
          .describe('Customer.io newsletter ID.'),
      },
      outputShape: {
        newsletter_id: z.string(),
        state: z.string().nullable(),
        scheduled_at: z.number().nullable(),
        original_scheduled_at: z.number().nullable(),
        send_at: z.number().nullable(),
        recurring: z.unknown().nullable(),
        start_at: z.number().nullable(),
        next_send_at: z.number().nullable(),
        timezone: z.string().nullable(),
        raw: z.unknown(),
      },
      handler: async (input, ctx) => {
        const id = encodeURIComponent(String(input.newsletter_id));
        const data = await appApiGet<{ newsletter?: NewsletterRecord }>(`/newsletters/${id}`, {
          correlationId: ctx.correlationId,
        });
        const n = data.newsletter ?? ({} as NewsletterRecord);
        return {
          data: {
            newsletter_id: String(input.newsletter_id),
            state: n.state ?? n.status ?? null,
            scheduled_at: n.scheduled_at ?? null,
            original_scheduled_at: n.original_scheduled_at ?? null,
            send_at: n.send_at ?? null,
            recurring: n.recurring ?? null,
            start_at: n.start_at ?? null,
            next_send_at: n.next_send_at ?? null,
            timezone: n.timezone ?? null,
            raw: n,
          },
        };
      },
    },
    callerHash,
  );
}
