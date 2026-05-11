import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { appApiGet, CustomerIoApiError } from '../../customerio/app-api-client.js';

export function registerGetNewsletterMetrics(
  server: McpServer,
  callerHash: CallerHashProvider,
): void {
  registerTool(
    server,
    {
      name: 'cio_get_newsletter_metrics',
      category: 'read',
      annotations: {
        title: 'Get Customer.io newsletter metrics',
        description:
          'Performance metrics for a newsletter: delivered, opens, prefetch opens, clicks, unsubscribes, bounces, complaints, plus link metrics and per-variant breakdowns when available.',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputShape: {
        newsletter_id: z
          .union([z.string(), z.number()])
          .describe('Customer.io newsletter ID.'),
        period: z
          .enum(['hours', 'days', 'weeks', 'months'])
          .optional()
          .describe('Aggregation period for the metrics endpoint (CIO default if omitted).'),
        steps: z.number().int().min(1).max(48).optional().describe('Number of period steps.'),
        include_links: z
          .boolean()
          .optional()
          .describe('If true, also fetch /metrics/links for link-level click data.'),
      },
      outputShape: {
        metrics: z.unknown(),
        links: z.unknown().nullable(),
        links_status: z.string(),
      },
      handler: async (input, ctx) => {
        const id = encodeURIComponent(String(input.newsletter_id));
        const query: Record<string, string | number | undefined> = {};
        if (input.period !== undefined) query.period = input.period;
        if (input.steps !== undefined) query.steps = input.steps;
        const metrics = await appApiGet<unknown>(`/newsletters/${id}/metrics`, {
          query,
          correlationId: ctx.correlationId,
        });

        let links: unknown = null;
        let links_status = 'not_requested';
        if (input.include_links === true) {
          try {
            links = await appApiGet<unknown>(`/newsletters/${id}/metrics/links`, {
              correlationId: ctx.correlationId,
            });
            links_status = 'ok';
          } catch (err) {
            if (err instanceof CustomerIoApiError && err.status === 404) {
              links_status = 'unsupported_via_api';
            } else {
              throw err;
            }
          }
        }
        return { data: { metrics, links, links_status } };
      },
    },
    callerHash,
  );
}
