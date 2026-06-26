import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { listNewsletterVariants } from '../../customerio/full-client.js';

export function registerCioNewsletterListVariants(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'cio_newsletter_list_variants',
    category: 'read',
    annotations: {
      title: 'List Customer.io newsletter content variants',
      description: 'List all content variants (A/B test variants) for a newsletter via App API GET /newsletters/{id}/contents. Returns variant IDs, subjects, and content metadata.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      newsletter_id: z.number().int().positive().describe('Numeric ID of the newsletter to list variants for.'),
    },
    outputShape: {
      variants: z.unknown(),
    },
    handler: async (input, ctx) => {
      const variants = await listNewsletterVariants({ newsletter_id: input.newsletter_id, correlationId: ctx.correlationId });
      return { data: { variants } };
    },
  }, callerHash);
}
