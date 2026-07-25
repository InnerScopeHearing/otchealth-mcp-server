import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { sendEmail } from '../../graph/api-client.js';
import { evaluateEmailMnpiGate } from '../../safety/mnpi-gate.js';

export function registerGraphSendEmail(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'graph_send_email',
    category: 'write_orchestrated',
    annotations: {
      title: 'Send email as a customer-service or COO persona mailbox',
      description: 'Send an email via Microsoft Graph as one of the allowlisted persona mailboxes (see the `from` param; defaults to coo@otchealthmart.com for back-compat). Uses application permissions (Mail.Send). Scoped autonomy: reply to Matt trusted addresses without approval; external/regulated stays gated. MNPI GATE (hard, code-level, not an LLM judgment): subject/body/recipients are scanned for an EXEC_RING-gated room reference or an explicit MNPI marker BEFORE send; a match to any external recipient is refused outright, a match to all-internal recipients requires an EXEC_RING caller lane. MAILBOX ALLOWLIST (code-level, see graph/api-client.ts): `from` is checked against GRAPH_CS_MAILBOXES -- an address outside that set is refused before any Graph call, standing in for the Exchange ApplicationAccessPolicy not yet provisioned.',
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
      from: z.string().optional().describe('Persona mailbox to send AS (e.g. care@otchealthmart.com, sarah@otchealthmart.com, helen@otchealthmart.com, ray@otchealthmart.com, coo@otchealthmart.com). Must be on the GRAPH_CS_MAILBOXES allowlist. Defaults to coo@otchealthmart.com.'),
    },
    outputShape: {
      sent: z.boolean(),
      to: z.string(),
      subject: z.string(),
      from: z.string().optional(),
    },
    handler: async (input, ctx) => {
      // MNPI DETERMINISTIC PRE-SHARE GATE (Wave 3 item 3.5, safety/mnpi-gate.ts). Runs BEFORE any
      // Graph call. Code-level, not an LLM judgment: a match to an EXTERNAL recipient is refused for
      // every caller; a match with every recipient internal requires an EXEC_RING caller lane.
      const recipientsCsv = [input.to, input.cc, input.bcc].filter(Boolean).join(',');
      const mnpiGate = evaluateEmailMnpiGate(
        { subject: input.subject, body: input.body, to: input.to, cc: input.cc, bcc: input.bcc, reply_to: input.reply_to },
        recipientsCsv,
        ctx.callerAgent,
      );
      if (mnpiGate.blocked) {
        return {
          data: { sent: false, to: input.to, subject: input.subject, mnpi_gate: mnpiGate },
          summary: `Refused: ${mnpiGate.reason}`,
        };
      }
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
        from: input.from,
      });
      return {
        data: { sent: true, to: input.to, subject: input.subject, from: input.from },
        summary: `Email sent to ${input.to} as ${input.from ?? 'coo@otchealthmart.com'}: "${input.subject}"`,
      };
    },
  }, callerHash);
}
