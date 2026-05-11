import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { appApiGet, CustomerIoApiError } from '../../customerio/app-api-client.js';

export function registerGetNewsletter(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(
    server,
    {
      name: 'cio_get_newsletter',
      category: 'read',
      annotations: {
        title: 'Get a Customer.io newsletter',
        description:
          'Fetch full metadata for a single newsletter in workspace 193366 — name, type, state, subject variants, audience reference, and schedule fields.',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputShape: {
        newsletter_id: z
          .union([z.string(), z.number()])
          .describe('Customer.io newsletter ID (numeric or string).'),
        include_contents: z
          .boolean()
          .optional()
          .describe('If true, attempt to fetch /contents (variants) alongside the newsletter.'),
      },
      outputShape: {
        newsletter: z.unknown(),
        contents: z.unknown().nullable(),
        contents_status: z.string(),
      },
      handler: async (input, ctx) => {
        const id = String(input.newsletter_id);
        const newsletter = await appApiGet<unknown>(`/newsletters/${encodeURIComponent(id)}`, {
          correlationId: ctx.correlationId,
        });

        let contents: unknown = null;
        let contents_status = 'not_requested';

        if (input.include_contents === true) {
          try {
            contents = await appApiGet<unknown>(`/newsletters/${encodeURIComponent(id)}/contents`, {
              correlationId: ctx.correlationId,
            });
            contents_status = 'ok';
          } catch (err) {
            if (err instanceof CustomerIoApiError && err.status === 404) {
              contents_status = 'unsupported_via_api';
            } else {
              throw err;
            }
          }
        }

        return {
          data: { newsletter, contents, contents_status },
        };
      },
    },
    callerHash,
  );
}
