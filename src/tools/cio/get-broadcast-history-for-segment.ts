import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { appApiGet } from '../../customerio/app-api-client.js';

/**
 * Customer.io does not expose a single "broadcasts for segment X" endpoint.
 * Approach: list recent newsletters, filter to those whose recipients/audience
 * reference the segment id, and best-effort attach metrics. The returned
 * `source_strategy` field documents how the result set was assembled.
 */

interface NewsletterListItem {
  id?: number | string;
  name?: string;
  state?: string;
  status?: string;
  created?: number;
  sent_at?: number | null;
  recipients?: unknown;
  audience?: unknown;
}

function targetsSegment(n: NewsletterListItem, segmentId: string): boolean {
  const blob = JSON.stringify({ recipients: n.recipients, audience: n.audience });
  return blob.includes(`"${segmentId}"`) || blob.includes(`:${segmentId},`) || blob.includes(`:${segmentId}}`);
}

export function registerGetBroadcastHistory(
  server: McpServer,
  callerHash: CallerHashProvider,
): void {
  registerTool(
    server,
    {
      name: 'cio_get_broadcast_history_for_segment',
      category: 'read',
      annotations: {
        title: 'Get broadcast history for a Customer.io segment',
        description:
          'Best-effort: lists newsletters likely sent to the given segment in the trailing N days, with metrics where available. Customer.io has no dedicated "broadcasts by segment" endpoint, so this joins newsletter recipients metadata to the segment id.',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputShape: {
        segment_id: z.union([z.string(), z.number()]),
        trailing_days: z.number().int().min(1).max(365).default(90).optional(),
        include_metrics: z.boolean().optional(),
        limit: z.number().int().min(1).max(200).optional(),
      },
      outputShape: {
        segment_id: z.string(),
        trailing_days: z.number(),
        source_strategy: z.string(),
        broadcasts: z.array(z.unknown()),
        count: z.number(),
      },
      handler: async (input, ctx) => {
        const segmentId = String(input.segment_id);
        const trailingDays = input.trailing_days ?? 90;
        const sinceEpoch = Math.floor(Date.now() / 1000) - trailingDays * 86_400;

        const list = await appApiGet<{ newsletters?: NewsletterListItem[] }>(`/newsletters`, {
          query: { limit: input.limit ?? 200 },
          correlationId: ctx.correlationId,
        });
        const all = list.newsletters ?? [];

        const candidates = all.filter((n) => {
          const sentTs = (n.sent_at ?? n.created) ?? 0;
          if (sentTs < sinceEpoch) return false;
          return targetsSegment(n, segmentId);
        });

        const broadcasts: Array<Record<string, unknown>> = [];
        for (const n of candidates) {
          const item: Record<string, unknown> = {
            id: n.id,
            name: n.name,
            state: n.state ?? n.status ?? null,
            sent_at: n.sent_at ?? null,
            created: n.created ?? null,
          };
          if (input.include_metrics === true && n.id !== undefined) {
            try {
              const m = await appApiGet<unknown>(
                `/newsletters/${encodeURIComponent(String(n.id))}/metrics`,
                { correlationId: ctx.correlationId },
              );
              item.metrics = m;
            } catch {
              item.metrics = null;
              item.metrics_status = 'unavailable';
            }
          }
          broadcasts.push(item);
        }

        return {
          data: {
            segment_id: segmentId,
            trailing_days: trailingDays,
            source_strategy:
              'list /newsletters, filter sent_at within window, join recipients/audience metadata to segment_id',
            broadcasts,
            count: broadcasts.length,
          },
          summary: `Found ${broadcasts.length} broadcast(s) targeting segment ${segmentId} in last ${trailingDays} days.`,
        };
      },
    },
    callerHash,
  );
}
