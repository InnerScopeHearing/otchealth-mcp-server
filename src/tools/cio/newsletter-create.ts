import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { createNewsletter } from '../../customerio/full-client.js';

export function registerCioNewsletterCreate(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'cio_newsletter_create',
    category: 'write_simple',
    annotations: {
      title: 'Create a Customer.io newsletter',
      description: 'Create a new newsletter/broadcast in the Customer.io workspace via App API POST /newsletters. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputShape: {
      name: z.string().min(1).describe('Internal name for the newsletter.'),
      subject: z.string().min(1).describe('Email subject line for the newsletter.'),
      from_id: z.number().int().positive().optional().describe('ID of the sender address to use.'),
      reply_to_id: z.number().int().positive().optional().describe('ID of the reply-to address to use.'),
      type: z.string().optional().describe('Newsletter type (e.g. "email"). Defaults to email.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      newsletter: z.unknown().nullable(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, newsletter: null },
          audit: { before: null, after: input },
          summary: `DRY RUN: would create newsletter "${input.name}". Pass dry_run=false to apply.`,
        };
      }
      const newsletter = await createNewsletter({ ...input, correlationId: ctx.correlationId });
      return {
        data: { executed: true, dry_run: false, newsletter },
        audit: { before: null, after: input },
        summary: `Newsletter "${input.name}" created.`,
      };
    },
  }, callerHash);
}
