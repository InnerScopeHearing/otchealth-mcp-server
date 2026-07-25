/**
 * mail_archive_* tools — TEMPORARY EWS-backed access to the Online Archive mailbox (see
 * tools/mail/client.ts header for the full context, auth design, and — importantly — the
 * retirement timeline this must be replaced before). Executive-ring gated, same as xero_*
 * (this mailbox is Matt's personal/financial correspondence — MNPI-adjacent by the same logic).
 * Read-only: list folders, search, read a message, download an attachment. No send, no delete.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import {
  isMailArchiveAllowed,
  mailRingRefusal,
  mailArchiveConfigured,
  ewsListArchiveFolders,
  resolveArchiveFolderId,
  ewsSearchItems,
  ewsGetMessage,
  ewsGetAttachment,
} from './client.js';

const TEMP_NOTICE =
  'TEMPORARY: this tool reads via Exchange Web Services (EWS), which Microsoft is retiring ' +
  '(phased disable starts 2026-10-01, full shutdown 2027-04-01). It is a short-term bridge for the ' +
  'CFO agent, not a permanent capability — do not build further dependencies on it.';

function unconfigured(tool: string) {
  return {
    data: { error: 'unconfigured' },
    summary: `${tool}: the mail archive gateway is not configured (MAIL_ARCHIVE_EWS_CLIENT_ID/SECRET/TENANT_ID required).`,
  };
}

export function registerMailArchiveTools(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(
    server,
    {
      name: 'mail_archive_list_folders',
      category: 'read',
      annotations: {
        title: 'Mail archive: list Online Archive folders (executive ring only, TEMPORARY)',
        description: `List the top-level folders in the Online Archive mailbox (Archive, Inbox, Sent Items, Drafts, Deleted Items, etc.) with item counts. ${TEMP_NOTICE}`,
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputShape: {},
      outputShape: { folders: z.array(z.unknown()), error: z.string().optional() },
      handler: async (_input, ctx) => {
        if (!isMailArchiveAllowed(ctx.callerAgent)) return mailRingRefusal('mail_archive_list_folders', ctx.callerAgent);
        if (!mailArchiveConfigured()) return unconfigured('mail_archive_list_folders');
        const folders = await ewsListArchiveFolders();
        return { data: { folders }, summary: `Online Archive folders: ${folders.map((f) => `${f.displayName} (${f.totalCount ?? '?'})`).join(', ')}.` };
      },
    },
    callerHash,
  );

  registerTool(
    server,
    {
      name: 'mail_archive_search',
      category: 'read',
      annotations: {
        title: 'Mail archive: search a folder (executive ring only, TEMPORARY)',
        description:
          `Search a named Online Archive folder (e.g. "Archive", "Inbox", "Sent Items", "Drafts") by subject substring and/or a DateTimeReceived range, sorted newest-first. Returns itemId/changeKey (needed for mail_archive_get_message), subject, date, sender, and whether it has attachments. ${TEMP_NOTICE}`,
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputShape: {
        folder: z.string().describe('Folder display name, e.g. "Archive", "Inbox", "Sent Items", "Drafts", "Deleted Items".'),
        subjectContains: z.string().optional().describe('Case-insensitive substring match on Subject.'),
        from: z.string().optional().describe('ISO 8601 date/time — only items received on/after this.'),
        to: z.string().optional().describe('ISO 8601 date/time — only items received on/before this.'),
        maxResults: z.number().int().min(1).max(100).optional().describe('Max results, default 25, hard cap 100.'),
      },
      outputShape: { folder: z.string(), results: z.array(z.unknown()), error: z.string().optional() },
      handler: async (input, ctx) => {
        if (!isMailArchiveAllowed(ctx.callerAgent)) return mailRingRefusal('mail_archive_search', ctx.callerAgent);
        if (!mailArchiveConfigured()) return unconfigured('mail_archive_search');
        const folder = await resolveArchiveFolderId(input.folder);
        const results = await ewsSearchItems({
          folderId: folder.folderId,
          subjectContains: input.subjectContains,
          from: input.from,
          to: input.to,
          maxResults: input.maxResults,
        });
        return {
          data: { folder: folder.displayName, results },
          summary: `${results.length} result(s) in "${folder.displayName}"${input.subjectContains ? ` matching "${input.subjectContains}"` : ''}.`,
        };
      },
    },
    callerHash,
  );

  registerTool(
    server,
    {
      name: 'mail_archive_get_message',
      category: 'read',
      annotations: {
        title: 'Mail archive: get a message (executive ring only, TEMPORARY)',
        description: `Fetch a specific message by itemId (from mail_archive_search): subject, sender, recipients, date, plain-text body, and a list of attachments (name/contentType/size/attachmentId — pass attachmentId to mail_archive_download_attachment). ${TEMP_NOTICE}`,
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputShape: {
        itemId: z.string().describe('The itemId from mail_archive_search.'),
      },
      outputShape: { message: z.unknown(), error: z.string().optional() },
      handler: async (input, ctx) => {
        if (!isMailArchiveAllowed(ctx.callerAgent)) return mailRingRefusal('mail_archive_get_message', ctx.callerAgent);
        if (!mailArchiveConfigured()) return unconfigured('mail_archive_get_message');
        const message = await ewsGetMessage(input.itemId);
        return {
          data: { message },
          summary: `"${message.subject ?? '(no subject)'}" from ${message.from ?? '(unknown)'} — ${message.attachments.length} attachment(s).`,
        };
      },
    },
    callerHash,
  );

  registerTool(
    server,
    {
      name: 'mail_archive_download_attachment',
      category: 'read',
      annotations: {
        title: 'Mail archive: download an attachment (executive ring only, TEMPORARY)',
        description: `Download a specific attachment by attachmentId (from mail_archive_get_message) as base64 content, name, and content type. 10MB cap. ${TEMP_NOTICE}`,
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputShape: {
        attachmentId: z.string().describe('The attachmentId from mail_archive_get_message.'),
      },
      outputShape: { name: z.string().optional(), contentType: z.string().optional(), bytes: z.number().optional(), contentBase64: z.string().optional(), error: z.string().optional() },
      handler: async (input, ctx) => {
        if (!isMailArchiveAllowed(ctx.callerAgent)) return mailRingRefusal('mail_archive_download_attachment', ctx.callerAgent);
        if (!mailArchiveConfigured()) return unconfigured('mail_archive_download_attachment');
        const att = await ewsGetAttachment(input.attachmentId);
        return {
          data: { name: att.name, contentType: att.contentType, bytes: att.bytes, contentBase64: att.contentBase64 },
          summary: `Downloaded "${att.name ?? '(unnamed)'}" (${att.contentType ?? 'unknown type'}, ${att.bytes} bytes).`,
        };
      },
    },
    callerHash,
  );
}
