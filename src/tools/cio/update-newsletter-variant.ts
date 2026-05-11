import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { appApiGet, CustomerIoApiError } from '../../customerio/app-api-client.js';
import { callN8nWebhook } from '../../n8n/webhook-client.js';

/**
 * Field allowlist for newsletter variant updates. Per ADR Section 4 and
 * Perplexity spec Section 4 (tool #10): only these fields may be touched.
 */
const ALLOWED_FIELDS = new Set([
  'subject',
  'preheader',
  'body_html',
  'from_name',
  'reply_to',
  'send_at',
]);

const FieldShape = z
  .object({
    subject: z.string().min(1).max(998).optional(),
    preheader: z.string().max(998).optional(),
    body_html: z.string().min(1).optional(),
    from_name: z.string().min(1).max(200).optional(),
    reply_to: z.string().email().optional(),
    send_at: z.number().int().optional(),
  })
  .strict()
  .refine((obj) => Object.keys(obj).length > 0, 'fields must contain at least one allowed key');

export function registerUpdateNewsletterVariant(
  server: McpServer,
  callerHash: CallerHashProvider,
): void {
  registerTool(
    server,
    {
      name: 'cio_update_newsletter_variant',
      category: 'write_orchestrated',
      annotations: {
        title: 'Update a Customer.io newsletter variant (n8n-orchestrated)',
        description:
          'Update allowlisted fields on a newsletter variant. Routed through n8n for retry, diff, and audit (ADR Section 4b). Fields allowed: subject, preheader, body_html, from_name, reply_to, send_at. Defaults to dry_run.',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      inputShape: {
        newsletter_id: z.union([z.string(), z.number()]),
        variant_id: z.union([z.string(), z.number()]).optional(),
        content_id: z.union([z.string(), z.number()]).optional(),
        fields: FieldShape,
      },
      outputShape: {
        executed: z.boolean(),
        dry_run: z.boolean(),
        newsletter_id: z.string(),
        variant_id: z.string().nullable(),
        before: z.unknown().nullable(),
        after: z.unknown().nullable(),
        n8n_response: z.unknown().nullable(),
      },
      handler: async (input, ctx) => {
        // Reject unknown field keys defensively (FieldShape.strict already handles it).
        for (const key of Object.keys(input.fields)) {
          if (!ALLOWED_FIELDS.has(key)) {
            throw new CustomerIoApiError({
              code: 'disallowed_field',
              status: 400,
              message: `Field "${key}" is not in the allowlist.`,
              nextStep: `Use only: ${[...ALLOWED_FIELDS].join(', ')}.`,
            });
          }
        }

        // Fetch current state for the before-diff.
        const id = encodeURIComponent(String(input.newsletter_id));
        const current = await appApiGet<unknown>(`/newsletters/${id}`, {
          correlationId: ctx.correlationId,
        });

        if (ctx.dryRun) {
          return {
            data: {
              executed: false,
              dry_run: true,
              newsletter_id: String(input.newsletter_id),
              variant_id: input.variant_id !== undefined ? String(input.variant_id) : null,
              before: current,
              after: { ...(current as object), pending_updates: input.fields },
              n8n_response: null,
            },
            audit: { before: current, after: { pending_updates: input.fields } },
            summary: 'DRY RUN: variant would be updated via n8n. Pass dry_run=false to apply.',
          };
        }

        // Hand off to n8n for the actual mutation.
        const variantId =
          input.variant_id !== undefined
            ? String(input.variant_id)
            : input.content_id !== undefined
              ? String(input.content_id)
              : null;
        const result = await callN8nWebhook({
          webhookPath: '/webhook/cio-update-newsletter-variant',
          toolName: 'cio_update_newsletter_variant',
          callerHash: ctx.callerHash,
          correlationId: ctx.correlationId,
          payload: {
            newsletter_id: String(input.newsletter_id),
            variant_id: variantId,
            fields: input.fields,
            before: current,
            correlation_id: ctx.correlationId,
          },
        });

        return {
          data: {
            executed: true,
            dry_run: false,
            newsletter_id: String(input.newsletter_id),
            variant_id: variantId,
            before: result.audit_payload?.before ?? current,
            after: result.audit_payload?.after ?? null,
            n8n_response: result,
          },
          audit: {
            before: result.audit_payload?.before ?? current,
            after: result.audit_payload?.after ?? input.fields,
          },
        };
      },
    },
    callerHash,
  );
}
