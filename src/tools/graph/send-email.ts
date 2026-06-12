import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { sendEmail } from '../../graph/api-client.js';

export function registerGraphSendEmail(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'graph_send_email',
    category: 'write_orchestrated',
    annotations: {
      title: 'Send email as COO',
      description: 'Send an email as coo@otchealthmart.com via Microsoft Graph. Uses application permissions (Mail.Send). Scoped autonomy: reply to Matt trusted addresses without approval; external/regulated stays gated.',
      readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true,
    },
    inputShape: {
      to: z.string().describe('Recipient email address (or comma-separated for multiple).'),
      subject: z.string().describe('Email subject line.'),
      body: z.string().describe('Email body content.'),
      body_type: z.enum(['Text', 'HTML']).optional().describe('Body format (default Text).'),
      cc: z.string().optional().describe('CC recipients (comma-separated).'),
      bcc: z.string().optional().describe('BCC recipients (comma-separated).'),
      reply_to: z.string().optional().describe('Reply-to address override.'),
      save_to_sent: z.boolean().optional().describe('Save to Sent Items (default true).'),
    },
    outputShape: {
      sent: z.boolean(),
      to: z.string(),
      subject: z.string(),
    },
    handler: async (input, _ctx) => {
      const toList = input.to.split(',').map((e: string) => e.trim()).filter(Boolean);
      const ccList = input.cc ? input.cc.split(',').map((e: string) => e.trim()).filter(Boolean) : undefined;
      const bccList = input.bcc ? input.bcc.split(',').map((e: string) => e.trim()).filter(Boolean) : undefined;
      await sendEmail({
        to: toList,
        subject: input.subject,
        body: input.body,
        bodyType: input.body_type,
        cc: ccList,
        bcc: bccList,
        replyTo: input.reply_to,
        saveToSentItems: input.save_to_sent,
      });
      return {
        data: { sent: true, to: input.to, subject: input.subject },
        summary: `Email sent to ${input.to}: "${input.subject}"`,
      };
    },
  }, callerHash);
}
