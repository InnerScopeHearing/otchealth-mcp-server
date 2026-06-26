import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { createDraft } from '../../graph/write-client.js';

export function registerGraphCreateDraft(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'graph_create_draft',
    category: 'write_simple',
    annotations: {
      title: 'Create email draft in COO mailbox',
      description: 'Save an email as a draft in coo@otchealthmart.com Drafts folder via Microsoft Graph POST /users/{sender}/messages. Does NOT send. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputShape: {
      to: z.string().describe('Recipient email address (or comma-separated for multiple).'),
      subject: z.string().describe('Email subject line.'),
      body: z.string().describe('Email body content.'),
      body_type: z.enum(['Text', 'HTML']).optional().describe('Body format (default Text).'),
      cc: z.string().optional().describe('CC recipients (comma-separated).'),
      bcc: z.string().optional().describe('BCC recipients (comma-separated).'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      draft_id: z.string().nullable(),
      subject: z.string(),
      to: z.string(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, draft_id: null, subject: input.subject, to: input.to },
          audit: { before: null, after: input },
          summary: `DRY RUN: would create draft "${input.subject}" to ${input.to}. Pass dry_run=false to apply.`,
        };
      }
      const toList = input.to.split(',').map((e: string) => e.trim()).filter(Boolean);
      const ccList = input.cc ? input.cc.split(',').map((e: string) => e.trim()).filter(Boolean) : undefined;
      const bccList = input.bcc ? input.bcc.split(',').map((e: string) => e.trim()).filter(Boolean) : undefined;
      const draft = await createDraft({
        to: toList,
        subject: input.subject,
        body: input.body,
        bodyType: input.body_type,
        cc: ccList,
        bcc: bccList,
      });
      return {
        data: { executed: true, dry_run: false, draft_id: draft.id, subject: draft.subject, to: input.to },
        audit: { before: null, after: input },
        summary: `Draft created (id: ${draft.id}) — subject: "${draft.subject}".`,
      };
    },
  }, callerHash);
}
