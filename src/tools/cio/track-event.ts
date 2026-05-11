import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { trackEvent } from '../../customerio/track-api-client.js';

/**
 * Allowlist of acceptable event names. Reject anything outside this list to
 * prevent ad-hoc, untracked events from leaking through the connector. Extend
 * via .env or a config table when new events graduate from staging.
 */
const ALLOWED_EVENT_NAMES = new Set([
  'mcp_test_event',
  'mcp_smoke_test',
  'cio_attribute_updated',
  'newsletter_preview_requested',
]);

export function registerTrackEvent(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(
    server,
    {
      name: 'cio_track_event',
      category: 'write_simple',
      annotations: {
        title: 'Track a Customer.io event (Track API)',
        description:
          'Fire a Track API event for a known identifier (email/id/cio_id). Event names are allowlisted. Defaults to dry_run.',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputShape: {
        identifier: z.string().min(1),
        identifier_type: z.enum(['email', 'id', 'cio_id']).default('email'),
        event_name: z
          .string()
          .min(2)
          .max(80)
          .refine((v) => ALLOWED_EVENT_NAMES.has(v), {
            message: `event_name must be one of: ${[...ALLOWED_EVENT_NAMES].join(', ')}`,
          }),
        data: z.record(z.unknown()).optional(),
        timestamp: z.number().int().optional(),
        idempotency_key: z
          .string()
          .min(8)
          .optional()
          .describe(
            'Optional caller-supplied idempotency key. Stored under data.idempotency_key for downstream dedup.',
          ),
      },
      outputShape: {
        executed: z.boolean(),
        dry_run: z.boolean(),
        identifier: z.string(),
        event_name: z.string(),
        upstream_response: z.unknown().nullable(),
      },
      handler: async (input, ctx) => {
        const data: Record<string, unknown> = { ...(input.data ?? {}) };
        if (input.idempotency_key) data.idempotency_key = input.idempotency_key;

        if (ctx.dryRun) {
          return {
            data: {
              executed: false,
              dry_run: true,
              identifier: input.identifier,
              event_name: input.event_name,
              upstream_response: null,
            },
            audit: { before: null, after: { event_name: input.event_name, identifier: input.identifier, data } },
            summary: 'DRY RUN: no Track API call made. Pass dry_run=false to actually send.',
          };
        }

        const trackArgs: {
          identifier: string;
          identifierType: 'email' | 'id' | 'cio_id';
          name: string;
          data: Record<string, unknown>;
          timestamp?: number;
          correlationId: string;
        } = {
          identifier: input.identifier,
          identifierType: input.identifier_type,
          name: input.event_name,
          data,
          correlationId: ctx.correlationId,
        };
        if (input.timestamp !== undefined) trackArgs.timestamp = input.timestamp;

        const upstream = await trackEvent(trackArgs);
        return {
          data: {
            executed: true,
            dry_run: false,
            identifier: input.identifier,
            event_name: input.event_name,
            upstream_response: upstream,
          },
          audit: {
            before: null,
            after: { event_name: input.event_name, identifier: input.identifier, data },
          },
        };
      },
    },
    callerHash,
  );
}
