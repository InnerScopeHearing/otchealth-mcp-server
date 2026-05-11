import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { appApiGet } from '../../customerio/app-api-client.js';
import { callN8nWebhook } from '../../n8n/webhook-client.js';

export function registerDuplicateNewsletter(
  server: McpServer,
  callerHash: CallerHashProvider,
): void {
  registerTool(
    server,
    {
      name: 'cio_duplicate_newsletter',
      category: 'write_orchestrated',
      annotations: {
        title: 'Duplicate a Customer.io newsletter (n8n-orchestrated)',
        description:
          'Duplicate an existing newsletter under a new name. Routed through n8n which performs the multi-step copy: fetch source, create copy, verify, return new id (ADR Section 4b). If Customer.io does not expose duplication via API, n8n returns unsupported_via_api. Defaults to dry_run.',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      inputShape: {
        source_newsletter_id: z.union([z.string(), z.number()]),
        new_name: z.string().min(3).max(200),
      },
      outputShape: {
        executed: z.boolean(),
        dry_run: z.boolean(),
        source_newsletter_id: z.string(),
        new_newsletter_id: z.string().nullable(),
        status: z.string(),
        n8n_response: z.unknown().nullable(),
      },
      handler: async (input, ctx) => {
        const sourceId = String(input.source_newsletter_id);
        const source = await appApiGet<unknown>(`/newsletters/${encodeURIComponent(sourceId)}`, {
          correlationId: ctx.correlationId,
        });

        if (ctx.dryRun) {
          return {
            data: {
              executed: false,
              dry_run: true,
              source_newsletter_id: sourceId,
              new_newsletter_id: null,
              status: 'dry_run_ok',
              n8n_response: null,
            },
            audit: { before: source, after: { plan: { new_name: input.new_name } } },
            summary: `DRY RUN: would duplicate newsletter ${sourceId} as "${input.new_name}". Pass dry_run=false to apply.`,
          };
        }

        const result = await callN8nWebhook({
          webhookPath: '/webhook/cio-duplicate-newsletter',
          toolName: 'cio_duplicate_newsletter',
          callerHash: ctx.callerHash,
          correlationId: ctx.correlationId,
          payload: {
            source_newsletter_id: sourceId,
            new_name: input.new_name,
            source_snapshot: source,
            correlation_id: ctx.correlationId,
          },
        });

        const r = (result.result ?? {}) as { new_newsletter_id?: string | number | null; status?: string };
        const newId = r.new_newsletter_id !== undefined && r.new_newsletter_id !== null ? String(r.new_newsletter_id) : null;
        return {
          data: {
            executed: true,
            dry_run: false,
            source_newsletter_id: sourceId,
            new_newsletter_id: newId,
            status: r.status ?? (result.success ? 'ok' : 'failed'),
            n8n_response: result,
          },
          audit: {
            before: source,
            after: { new_newsletter_id: newId, status: r.status ?? null },
          },
        };
      },
    },
    callerHash,
  );
}
