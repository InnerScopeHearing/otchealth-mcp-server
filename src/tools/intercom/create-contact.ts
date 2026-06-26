import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { createContact } from '../../intercom/write-client.js';

export function registerIntercomCreateContact(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'intercom_create_contact',
    category: 'write_simple',
    annotations: {
      title: 'Create an Intercom contact (user or lead)',
      description: 'Create a new contact in Intercom via POST /contacts. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputShape: {
      role: z.enum(['user', 'lead']).describe('"user" for known customers; "lead" for anonymous or prospect contacts.'),
      email: z.string().email().optional().describe('Contact email address.'),
      name: z.string().optional().describe('Full name of the contact.'),
      phone: z.string().optional().describe('Phone number (E.164 preferred).'),
      external_id: z.string().optional().describe('Your system identifier for this contact.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      contact_id: z.string().nullable(),
      role: z.string(),
      email: z.string().nullable(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, contact_id: null, role: input.role, email: input.email ?? null },
          audit: { before: null, after: input },
          summary: `DRY RUN: would create ${input.role} contact${input.email ? ` for ${input.email}` : ''}. Pass dry_run=false to apply.`,
        };
      }
      const resp = await createContact({
        role: input.role,
        email: input.email,
        name: input.name,
        phone: input.phone,
        external_id: input.external_id,
      });
      const contact = resp.contact ?? resp;
      return {
        data: {
          executed: true,
          dry_run: false,
          contact_id: contact.id ?? null,
          role: contact.role ?? input.role,
          email: contact.email ?? input.email ?? null,
        },
        audit: { before: null, after: input },
        summary: `Contact created (id: ${contact.id ?? 'unknown'}).`,
      };
    },
  }, callerHash);
}
