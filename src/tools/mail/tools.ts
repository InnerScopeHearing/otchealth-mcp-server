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
import { loadEnv } from '../../config/env.js';
import { putBlobRaw } from '../../legal/blob-store.js';
import { isSafeBlobPath } from '../kb/get-document.js';
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

/** Same physical store kb_get_document reads from (account otchealthcfodata, container
 * cfo-source-docs) — see that file's header for the account/container mapping. Attachments saved
 * here land under a dedicated mail-archive-attachments/ prefix so they're visually distinct from
 * the doc-indexer's own _TEXT/ sidecars, but they're the SAME container so kb_get_document can
 * read them straight back by path once saved. */
const DATAROOM_CONTAINER = 'cfo-source-docs';
const DATAROOM_ROOT = 'mail-archive-attachments';

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
          `Search a named Online Archive folder (e.g. "Archive", "Inbox", "Sent Items", "Drafts") by subject substring, body substring, and/or a DateTimeReceived range. Returns itemId/changeKey (needed for mail_archive_get_message), subject, dateTimeReceived, sender, and whether it has attachments. ` +
          `RESULTS ARE PAGED AND MAY BE INCOMPLETE: this returns at most \`maxResults\` items (default 25) starting at \`offset\`, sorted newest-first by default. ALWAYS read \`truncated\` and \`totalInView\` in the response before concluding something is absent — a "no hits" or "only these hits" reading of a truncated page is a FALSE NEGATIVE, not proof. When \`truncated\` is true, page with \`offset\`, or narrow the date range. For historical work (a prior-year close) pass \`sort:"oldest"\`: newest-first plus a 25-item cap hides precisely the oldest matches you are looking for. ` +
          `There is no attachment-filename search — EWS's restriction language has no indexed field for that; search broadly and filter attachment names client-side against mail_archive_get_message results instead. ${TEMP_NOTICE}`,
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputShape: {
        folder: z.string().describe('Folder display name, e.g. "Archive", "Inbox", "Sent Items", "Drafts", "Deleted Items".'),
        subjectContains: z.string().optional().describe('Case-insensitive substring match on Subject.'),
        bodyContains: z.string().optional().describe('Case-insensitive match on the message body — use this for content named generically in the subject (e.g. a counterparty mentioned only in the body). IMPORTANT: this is TOKEN-INDEXED, not substring — EWS content indexing matches whole words, not arbitrary character sequences. Confirmed live (2026-07-25): "wire transfer"/"Fedwire"/"Disbursement" all match correctly, but a dollar amount like "155,000" or a reference code like "INND16" returns ZERO hits even when the email genuinely contains it — these are FALSE NEGATIVES, not proof of absence. Never conclude "not documented" from a zero-hit amount/code search; search for surrounding words instead (e.g. the counterparty name or "wire") and inspect hits manually.'),
        from: z.string().optional().describe('ISO 8601 date/time — only items received on/after this.'),
        to: z.string().optional().describe('ISO 8601 date/time — only items received on/before this.'),
        maxResults: z.number().int().min(1).max(100).optional().describe('Max results per page, default 25, hard cap 100. This is a PAGE SIZE, not the match count -- check `totalInView`/`truncated` in the response before concluding you have seen everything.'),
        offset: z.number().int().min(0).optional().describe('Zero-based index of the first result, for paging past maxResults. Combine with `totalInView` from a previous call to walk the full match set.'),
        sort: z.enum(['newest', 'oldest']).optional().describe('Sort by DateTimeReceived. Default "newest". Use "oldest" for historical reconstruction: searching a closed year newest-first and capping at 25 hides the OLDEST matches, which are usually the ones a prior-year close needs.'),
      },
      outputShape: {
        folder: z.string(),
        results: z.array(z.unknown()),
        totalInView: z.number().nullable().optional(),
        returned: z.number().optional(),
        offset: z.number().optional(),
        truncated: z.boolean().optional(),
        error: z.string().optional(),
      },
      handler: async (input, ctx) => {
        if (!isMailArchiveAllowed(ctx.callerAgent)) return mailRingRefusal('mail_archive_search', ctx.callerAgent);
        if (!mailArchiveConfigured()) return unconfigured('mail_archive_search');
        const folder = await resolveArchiveFolderId(input.folder);
        const res = await ewsSearchItems({
          folderId: folder.folderId,
          subjectContains: input.subjectContains,
          bodyContains: input.bodyContains,
          from: input.from,
          to: input.to,
          maxResults: input.maxResults,
          offset: input.offset,
          sort: input.sort,
        });
        const criteria =
          `${input.subjectContains ? ` matching subject "${input.subjectContains}"` : ''}` +
          `${input.bodyContains ? ` matching body "${input.bodyContains}"` : ''}`;
        // The truncation state leads the summary. A caller who reads only the first line still
        // learns that the result set is partial, which is the whole point of the fix.
        const scope = res.truncated
          ? `PARTIAL RESULTS -- showing ${res.hits.length} of ${res.totalInView ?? 'an unknown number of'} match(es)` +
            ` starting at offset ${res.offset}. More exist: re-query with offset=${res.offset + res.hits.length}` +
            ` (or sort:"oldest") before concluding anything is absent.`
          : `${res.hits.length} result(s)${res.totalInView !== null ? ` of ${res.totalInView} match(es)` : ''} -- this is the COMPLETE match set.`;
        return {
          data: {
            folder: folder.displayName,
            results: res.hits,
            totalInView: res.totalInView,
            returned: res.hits.length,
            offset: res.offset,
            truncated: res.truncated,
          },
          summary: `${scope} In "${folder.displayName}"${criteria}.`,
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
        description: `Fetch a specific message by itemId (from mail_archive_search): subject, sender, recipients, date, body (bodyText + bodyType — bodyType is "Text" when a real plain-text part existed, or "HTML" when bodyText is the auto-stripped fallback from HTML-only mail; an empty bodyText with bodyType "HTML" means even the stripped HTML was empty, a genuinely contentless message rather than an extraction failure), and a list of attachments (name/contentType/size/attachmentId — pass attachmentId to mail_archive_download_attachment). ${TEMP_NOTICE}`,
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
          summary: `"${message.subject ?? '(no subject)'}" from ${message.from ?? '(unknown)'} — ${message.attachments.length} attachment(s), body type ${message.bodyType ?? '(unknown)'}.`,
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
        description: `Download a specific attachment by attachmentId (from mail_archive_get_message). Returns clean base64 in contentBase64 (fixed 2026-07-25 — a prior version leaked raw EWS SOAP fragments into this field; decode it directly, no cleanup needed), plus name, contentType, and the decoded byte count. 10MB cap. ${TEMP_NOTICE}`,
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

  // --- 2026-07-25 addition (CFO P2, FY2021 close volume): write straight to the finance dataroom
  // instead of round-tripping base64 through the caller. Durably preserves the evidence in the
  // same store kb_get_document reads from, and skips the base64/token overhead entirely for the
  // 200-500 attachments the FY2021 close needs. dry_run defaults true (decodes + previews the
  // target path without writing), same pattern as xero_attachment_upload. ---
  registerTool(
    server,
    {
      name: 'mail_archive_save_attachment_to_dataroom',
      category: 'write_simple',
      annotations: {
        title: 'Mail archive: save an attachment to the finance dataroom (executive ring only, TEMPORARY)',
        description:
          `Download an attachment by attachmentId (from mail_archive_get_message) and write it directly to the finance dataroom (account otchealthcfodata, container ${DATAROOM_CONTAINER}, under ${DATAROOM_ROOT}/<prefix>/<filename>) instead of returning base64. Returns the blob path — fetch it back anytime with kb_get_document (index "finance-cfo-source-docs" or "finance-otchealth-cfo-source-docs", same path). ` +
          `prefix organizes a close/audit batch, e.g. "fy2021-close-innd/gs-capital-notes". filename defaults to the attachment's own name from EWS; override it if that name collides or is unhelpful (e.g. many bank statements literally named "statement.pdf"). ` +
          `dry_run defaults TRUE (like every write tool in this gateway) — if you omit dry_run entirely, the call silently does NOTHING and only previews the target path/size; pass dry_run:false explicitly to actually save. Refuses to silently overwrite an existing blob unless overwrite:true. Note: this does NOT get indexed by the doc-indexer / show up in kb_search_privileged automatically — it is reachable by exact path via kb_get_document immediately, but won't surface in a semantic search until a future reindex. Being a WRITE tool, the response text may be prefixed with a COLD_START nudge line before the JSON payload if you haven't called wake() yet this session (fleet-wide behavior on every mutating tool, not specific to this one) — call wake() once per session to clear it, or parse past the first line if you're doing strict JSON parsing. ${TEMP_NOTICE}`,
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      inputShape: {
        attachmentId: z.string().describe('The attachmentId from mail_archive_get_message.'),
        prefix: z.string().min(1).describe('Folder path under mail-archive-attachments/ to organize this batch, e.g. "fy2021-close-innd/gs-capital-notes".'),
        filename: z.string().optional().describe("Override the blob's filename. Defaults to the attachment's own name from EWS."),
        overwrite: z.boolean().optional().describe('Allow replacing an existing blob at the same path. Default false (refuses to silently clobber).'),
      },
      outputShape: {
        path: z.string().optional(),
        container: z.string().optional(),
        bytes: z.number().optional(),
        contentType: z.string().optional(),
        error: z.string().optional(),
      },
      handler: async (input, ctx) => {
        if (!isMailArchiveAllowed(ctx.callerAgent)) return mailRingRefusal('mail_archive_save_attachment_to_dataroom', ctx.callerAgent);
        if (!mailArchiveConfigured()) return unconfigured('mail_archive_save_attachment_to_dataroom');
        const env = loadEnv();
        if (!env.AZURE_CFO_STORAGE_KEY) {
          return {
            data: { error: 'unconfigured' },
            summary: 'mail_archive_save_attachment_to_dataroom: the finance dataroom is not configured (AZURE_CFO_STORAGE_KEY unset).',
          };
        }

        const att = await ewsGetAttachment(input.attachmentId);
        const filename = input.filename || att.name || input.attachmentId;
        const relPath = `${DATAROOM_ROOT}/${input.prefix}/${filename}`;
        if (!isSafeBlobPath(relPath)) {
          return {
            data: { error: 'invalid_path' },
            summary: 'Refused: prefix/filename must not contain ".." or path traversal, and must be container-relative.',
          };
        }

        if (ctx.dryRun) {
          return {
            data: { path: relPath, container: DATAROOM_CONTAINER, bytes: att.bytes, contentType: att.contentType },
            summary: `DRY RUN (nothing saved): would write "${att.name ?? '(unnamed)'}" (${att.bytes} bytes, ${att.contentType ?? 'unknown type'}) to ${DATAROOM_CONTAINER}/${relPath}. Re-call with dry_run:false to actually save.`,
          };
        }

        const put = await putBlobRaw(
          env.AZURE_CFO_STORAGE_ACCOUNT,
          env.AZURE_CFO_STORAGE_KEY,
          DATAROOM_CONTAINER,
          relPath,
          { base64: att.contentBase64, contentType: att.contentType || 'application/octet-stream' },
          input.overwrite ?? false,
        );
        return {
          data: { path: put.path, container: put.container, bytes: put.bytes, contentType: put.contentType },
          summary: `Saved "${att.name ?? '(unnamed)'}" (${put.bytes} bytes) to ${put.container}/${put.path}. Fetch it back anytime with kb_get_document.`,
        };
      },
    },
    callerHash,
  );
}
