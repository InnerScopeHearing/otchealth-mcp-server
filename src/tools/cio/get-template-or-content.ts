import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { appApiGet, CustomerIoApiError } from '../../customerio/app-api-client.js';

/**
 * Best-effort retrieval of newsletter body / template content. CIO's App API
 * does not always expose rendered HTML for newsletters; we try the documented
 * /newsletters/{id}/contents endpoint and a few sibling variants, and report
 * `source: "unsupported_via_api"` if none succeed.
 */
export function registerGetTemplateOrContent(
  server: McpServer,
  callerHash: CallerHashProvider,
): void {
  registerTool(
    server,
    {
      name: 'cio_get_template_or_content',
      category: 'read',
      annotations: {
        title: 'Get newsletter or content template (best-effort)',
        description:
          'Best-effort retrieval of newsletter body, subject, preheader, and variants. Customer.io UI is authoritative for content for many workflows — when no API path works this returns source="unsupported_via_api".',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputShape: {
        newsletter_id: z.union([z.string(), z.number()]).optional(),
        content_id: z.union([z.string(), z.number()]).optional(),
      },
      outputShape: {
        source: z.string(),
        path_tried: z.array(z.string()),
        content: z.unknown().nullable(),
        note: z.string(),
      },
      handler: async (input, ctx) => {
        if (!input.newsletter_id && !input.content_id) {
          throw new CustomerIoApiError({
            code: 'invalid_input',
            status: 400,
            message: 'Provide newsletter_id and/or content_id.',
            nextStep:
              'Call cio_list_newsletters first, then pass the returned id into this tool.',
          });
        }
        const tried: string[] = [];
        const candidates: string[] = [];
        if (input.newsletter_id !== undefined) {
          const id = encodeURIComponent(String(input.newsletter_id));
          candidates.push(
            `/newsletters/${id}/contents`,
            `/newsletters/${id}/variants`,
            `/newsletters/${id}`,
          );
        }
        if (input.content_id !== undefined) {
          const cid = encodeURIComponent(String(input.content_id));
          candidates.push(`/contents/${cid}`, `/templates/${cid}`);
        }

        for (const path of candidates) {
          tried.push(path);
          try {
            const data = await appApiGet<unknown>(path, { correlationId: ctx.correlationId });
            return {
              data: {
                source: path,
                path_tried: tried,
                content: data,
                note: 'Retrieved via Customer.io App API. Note: HTML body may not be rendered output — UI remains authoritative for some templates.',
              },
            };
          } catch (err) {
            if (err instanceof CustomerIoApiError && err.status === 404) {
              continue;
            }
            if (err instanceof CustomerIoApiError && (err.status === 401 || err.status === 403)) {
              throw err;
            }
            continue;
          }
        }

        return {
          data: {
            source: 'unsupported_via_api',
            path_tried: tried,
            content: null,
            note: 'Customer.io did not expose this content through any documented App API path. Customer.io UI is authoritative; pull HTML directly from the newsletter editor at https://fly.customer.io/.',
          },
        };
      },
    },
    callerHash,
  );
}
