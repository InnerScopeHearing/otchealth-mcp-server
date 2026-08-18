/**
 * xero_* tools — full READ + WRITE for the executive ring (see client.ts header for the ring +
 * token-rotation design). 23 tools, all EXEC_RING-gated in-handler. They cover the FULL consented
 * OAuth scope surface (accounting + all reports + payroll + files + assets + projects), across all
 * four orgs, rate-governed. The CFO seat is authorized for full read+write on the books (Matt
 * directive 2026-07-16); Xero writes are bookkeeping (they post to the ledger, they do NOT move real
 * money — bank execution is separate). xero_request is the write tool (POST/PUT/DELETE, dry-run-first).
 *
 * Universal backstops:
 *   xero_get                READ  — ANY endpoint on ANY scoped API (api: accounting|payroll|assets|projects|files)
 *   xero_request            WRITE — POST/PUT/DELETE ANY scoped endpoint (dry_run defaults true)
 * Accounting (api.xro/2.0):
 *   xero_orgs               org registry + connection status (never token values)
 *   xero_connections        raw connection metadata (id/tenant/createdDateUtc); does NOT determine journals-scope grandfather eligibility (see tool description)
 *   xero_report             TrialBalance | BalanceSheet | ProfitAndLoss | Aged{Payables,Receivables}ByContact |
 *                           BankSummary | BudgetSummary | ExecutiveSummary | TenNinetyNine (1099); nonZeroOnly/match filter client-side
 *   xero_gl_assemble        server-side GL reconstruction: reads each month's own TrialBalance period movement directly (never diffed against another month), netted against ManualJournals — see gl-assemble.ts
 *   xero_accounts           full chart of accounts
 *   xero_contacts           contacts (customers + suppliers), paged/filterable
 *   xero_invoices           invoices (AR + AP), paged/filterable
 *   xero_credit_notes       credit notes (AR + AP)
 *   xero_payments           payments (cash applied)
 *   xero_bank_transactions  bank transactions, paged
 *   xero_bank_transfers     transfers between own bank accounts — gateway-side page/date shim (Xero's endpoint ignores both server-side)
 *   xero_manual_journals    manual journals (list or one by id)
 *   xero_budgets            budgets (list or one by id)
 *   xero_settings           Organisation | TaxRates | TrackingCategories | Currencies | Users |
 *                           BrandingThemes | ContactGroups | Items
 *   xero_attachments        source-doc attachment METADATA on a record (filename/mime/size — not the bytes)
 *   xero_attachment_content fetch an attachment's actual BYTES (base64, or text when genuinely text) — see client.ts xeroGetAttachmentContent
 *   xero_attachment_upload  upload a source-doc attachment (dry-run-first, truncation-guarded via expected_bytes/expected_sha256) — see client.ts xeroUploadAttachment
 * Other product APIs:
 *   xero_payroll            Employees | PayRuns | PayItems | PayrollCalendars | Timesheets | Settings (payroll.xro/1.0)
 *   xero_assets             Assets | AssetTypes | Settings (assets.xro/1.0)
 *   xero_projects           Projects | Tasks | Time (projects.xro/2.0)
 *   xero_files              Files | Folders | Associations (files.xro/1.0)
 *
 * The three paged accounting reads (contacts/payments/credit_notes) register via the shared
 * registerPagedAccountingRead helper (one gated call-site each stays EXEC_RING-checked);
 * bank_transfers has its own dedicated handler (see the block above xero_request).
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { registerTool, type CallerHashProvider, type ToolContext, type ToolResultPayload } from '../registry.js';
import {
  XERO_ORGS,
  XERO_API_BASES,
  type XeroApi,
  type XeroOrg,
  type TokenDeps,
  type XeroAttachmentIdentifier,
  isXeroAllowed,
  ringRefusal,
  xeroConfigured,
  configuredOrgs,
  getOrgAccess,
  xeroGet,
  xeroRequest,
  xeroUploadAttachment,
  xeroGetAttachmentContent,
  MAX_ATTACHMENT_READ_BYTES,
  xeroConnections,
  isGrandfatheredForJournals,
  XERO_JOURNALS_GRANDFATHER_CUTOFF,
} from './client.js';
// Reused, not reimplemented: the SAME binary-vs-text heuristic already reviewed and trusted for the
// finance dataroom (kb_get_document) — a NUL byte / known magic number means "do not decode this as
// UTF-8 and call it a document" there, and the identical reasoning applies to a byte blob fetched
// live from Xero.
import { looksBinary } from '../kb/get-document.js';
import { assembleGl } from './gl-assemble.js';
import {
  collectionOf,
  isCreate,
  unwrapItems,
  naturalKeyOf,
  manualJournalKeyGaps,
  manualJournalMatches,
  findAccountCodeViolations,
  existsFilterFor,
  readExisting,
  blocksCreate,
} from './write-guard.js';

const ORG_ENUM = z.enum(XERO_ORGS).describe('Which org: otchealth | innd | hearingassist | personal.');

const REPORTS = [
  'TrialBalance',
  'BalanceSheet',
  'ProfitAndLoss',
  'AgedPayablesByContact',
  'AgedReceivablesByContact',
  'BankSummary',
  'BudgetSummary',
  'ExecutiveSummary',
  'TenNinetyNine',
] as const;
const API_ENUM = Object.keys(XERO_API_BASES) as [XeroApi, ...XeroApi[]];
const ATTACHMENT_ENDPOINT_ENUM = [
  'Invoices',
  'CreditNotes',
  'BankTransactions',
  'BankTransfers',
  'Payments',
  'ManualJournals',
  'Receipts',
  'Contacts',
  'PurchaseOrders',
] as const;

interface ReportRow {
  RowType?: string;
  Cells?: Array<{ Value?: string }>;
  Rows?: ReportRow[];
}
interface ReportBody {
  Reports?: Array<{ Rows?: ReportRow[] }>;
}

/**
 * Post-fetch, client-side row filter for xero_report (CFO P1-C, 2026-07-30): a single TrialBalance
 * read is ~295KB and JIT-offloads into ~10 pages, and most reads only need a handful of accounts or
 * only the ones with activity. Xero's Reports API has no server-side account/column filter, so this
 * trims the SAME response after the fact rather than paying for a second, narrower call.
 * `Header` rows are always kept. `Section` rows are kept only if at least one child row survives.
 * `SummaryRow` handling differs by filter: `nonZeroOnly` alone never changes a true total (dropping
 * literal-zero rows cannot change a sum), so SummaryRow is kept. `match` genuinely subsets the
 * accounts shown, so a kept SummaryRow would display Xero's ORIGINAL total (including every
 * excluded account) beside a partial account list — internally inconsistent and misleading for a
 * financial reader. When `match` is active, SummaryRow rows are dropped rather than shown stale;
 * this function does not attempt to recompute a correct subset total (re-summing formatted decimal
 * strings client-side is its own source of rounding/formatting bugs). No-op (body unchanged) when
 * neither filter is requested.
 */
export function filterReportRows(body: unknown, opts: { nonZeroOnly?: boolean; match?: string[] }): unknown {
  if (!opts.nonZeroOnly && !opts.match?.length) return body;
  const b = body as ReportBody;
  const report = b?.Reports?.[0];
  if (!report?.Rows) return body;
  const matchList = opts.match?.length ? opts.match.map((s) => s.toLowerCase()) : null;
  const filterRows = (rows: ReportRow[]): ReportRow[] =>
    rows
      .map((r) => {
        if (r.RowType === 'Section' && Array.isArray(r.Rows)) {
          const kept = filterRows(r.Rows);
          return kept.length ? { ...r, Rows: kept } : null;
        }
        if (r.RowType === 'SummaryRow') return matchList ? null : r; // stale total once `match` subsets accounts — drop it
        if (r.RowType !== 'Row' || !Array.isArray(r.Cells)) return r; // Header untouched
        const label = (r.Cells[0]?.Value || '').toLowerCase();
        if (matchList && !matchList.some((m) => label.includes(m))) return null;
        if (opts.nonZeroOnly) {
          const allZero = r.Cells.slice(1).every((c) => !c.Value || Number.parseFloat(c.Value) === 0);
          if (allZero) return null;
        }
        return r;
      })
      .filter((r): r is ReportRow => r !== null);
  return { ...b, Reports: [{ ...report, Rows: filterRows(report.Rows) }, ...(b.Reports?.slice(1) ?? [])] };
}

/**
 * Pure truncation/corruption guard for xero_attachment_upload (CFO P1-B, 2026-07-30): given the
 * decoded payload buffer and the sha256 already computed over it, checks the caller-supplied
 * expected_bytes/expected_sha256 (computed by the CALLER from the ORIGINAL file, before base64-
 * encoding/pasting) against the actual decoded bytes. Returns null when the payload matches (or
 * neither check was requested — both are optional), or the exact `{error, reason}` pair the handler
 * returns to the caller WITHOUT ever calling Xero. Extracted as a standalone pure function (rather
 * than inline in the registerTool handler) so this safety-critical check is directly unit-testable
 * without needing to stand up the full registerTool/EXEC_RING/Cosmos gating stack — mirrors the
 * exported-handler pattern in tools/graph-drive/upload.ts.
 */
export function checkAttachmentPayloadIntegrity(
  buf: Buffer,
  actualSha256: string,
  opts: { expected_bytes?: number; expected_sha256?: string },
): { error: 'truncated_payload'; reason: string } | null {
  if (opts.expected_bytes !== undefined && buf.length !== opts.expected_bytes) {
    return {
      error: 'truncated_payload',
      reason: `decoded contentBase64 is ${buf.length} bytes but expected_bytes was ${opts.expected_bytes}. This is the exact silent-truncation failure mode this check exists to catch — re-send the full file rather than retrying with the same short payload.`,
    };
  }
  if (opts.expected_sha256 !== undefined && actualSha256 !== opts.expected_sha256.toLowerCase()) {
    return {
      error: 'truncated_payload',
      reason: `decoded contentBase64 hashes to ${actualSha256} but expected_sha256 was ${opts.expected_sha256}. Content does not match the original file — likely truncated or corrupted in transit; re-send the full file rather than retrying with the same payload.`,
    };
  }
  return null;
}

export interface XeroAttachmentUploadInput {
  org: XeroOrg;
  endpoint: (typeof ATTACHMENT_ENDPOINT_ENUM)[number];
  guid: string;
  fileName: string;
  contentBase64: string;
  mimeType: string;
  expected_bytes?: number;
  expected_sha256?: string;
}

/**
 * `xero_attachment_upload` handler. Exported standalone (rather than inline in the registerTool
 * call) so it is directly unit-testable — mirrors handleGraphDriveUpload's pattern in
 * tools/graph-drive/upload.ts. Copilot review, 2026-07-30: the prior tests only exercised the
 * extracted checkAttachmentPayloadIntegrity() pure function, never this handler itself, so nothing
 * proved a mismatch actually returns BEFORE xeroUploadAttachment (and therefore any network call)
 * is reached, nor that a genuinely matching payload reaches it. See tools.test.ts's
 * "handleXeroAttachmentUpload" tests for both proofs (a stubbed globalThis.fetch that throws on ANY
 * call demonstrates the refusal path makes zero network I/O).
 */
export async function handleXeroAttachmentUpload(
  input: XeroAttachmentUploadInput,
  ctx: ToolContext,
  // Test-only seam, mirroring assembleGl's deps parameter in gl-assemble.ts: production
  // (registerTool always calls handler(input, ctx), exactly 2 args) never supplies this, so it is
  // always undefined -- and undefined -> xeroUploadAttachment's own defaultDeps, unchanged behavior.
  deps?: TokenDeps,
): Promise<ToolResultPayload> {
  if (!isXeroAllowed(ctx.callerAgent)) return ringRefusal('xero_attachment_upload', ctx.callerAgent);
  if (!xeroConfigured()) return unconfigured('xero_attachment_upload');

  let buf: Buffer;
  try {
    buf = Buffer.from(input.contentBase64, 'base64');
  } catch {
    return {
      data: { org: input.org, endpoint: input.endpoint, guid: input.guid, fileName: input.fileName, body: null, error: 'bad_base64' },
      summary: 'xero_attachment_upload: contentBase64 did not decode as valid base64.',
    };
  }
  if (buf.length === 0) {
    return {
      data: { org: input.org, endpoint: input.endpoint, guid: input.guid, fileName: input.fileName, body: null, error: 'empty_content' },
      summary: 'xero_attachment_upload: decoded content is empty.',
    };
  }

  // TRUNCATION GUARD: check BEFORE dry_run too, so a dry-run preview never reports a plausible
  // "would upload N bytes" for a payload that was already truncated on the way into this call.
  const actualSha256 = createHash('sha256').update(buf).digest('hex');
  const integrityFailure = checkAttachmentPayloadIntegrity(buf, actualSha256, {
    expected_bytes: input.expected_bytes,
    expected_sha256: input.expected_sha256,
  });
  if (integrityFailure) {
    return {
      data: { org: input.org, endpoint: input.endpoint, guid: input.guid, fileName: input.fileName, bytes: buf.length, sha256: actualSha256, body: null, error: integrityFailure.error },
      summary: `REFUSED (not uploaded): ${integrityFailure.reason}`,
    };
  }

  if (ctx.dryRun) {
    return {
      data: {
        org: input.org,
        endpoint: input.endpoint,
        guid: input.guid,
        fileName: input.fileName,
        bytes: buf.length,
        sha256: actualSha256,
        body: null,
        error: 'dry_run',
      },
      summary: `DRY RUN (nothing uploaded): would PUT ${buf.length} bytes (sha256=${actualSha256}) as "${input.fileName}" (${input.mimeType}) to ${input.endpoint}/${input.guid} for ${input.org}. Re-call with dry_run:false to execute, then verify with xero_attachments.`,
    };
  }

  const res = await xeroUploadAttachment(input.org, input.endpoint, input.guid, input.fileName, buf, input.mimeType, { deps });
  return {
    data: { org: input.org, endpoint: input.endpoint, guid: input.guid, fileName: input.fileName, bytes: buf.length, sha256: actualSha256, body: res.body },
    summary:
      `Xero attachment upload "${input.fileName}" (${buf.length} bytes, sha256=${actualSha256}) to ${input.endpoint}/${input.guid} for ${input.org} — HTTP ${res.status}. ` +
      `NOT independently verified yet — call xero_attachments(org:"${input.org}", endpoint:"${input.endpoint}", guid:"${input.guid}") before reporting this as successful.`,
  };
}

export interface XeroAttachmentContentInput {
  org: XeroOrg;
  endpoint: (typeof ATTACHMENT_ENDPOINT_ENUM)[number];
  guid: string;
  fileName?: string;
  attachmentId?: string;
}

/**
 * `xero_attachment_content` handler — the READ counterpart to handleXeroAttachmentUpload above.
 * Exported standalone for the same reason (direct unit-testability with a stubbed fetchImpl,
 * mirroring the handleXeroAttachmentUpload / handleGraphDriveUpload pattern).
 *
 * Every distinct XeroAttachmentContentOutcome (client.ts) maps to its OWN named `error` code here —
 * deliberately NOT collapsed into a single generic branch — so "not found", "forbidden", "auth
 * failed", "too large", and "Xero returned something unexpected" can never be confused with each
 * other by a caller reading only `error`. This is the direct fix for the failure class the task that
 * built this tool was scoped around: a 403 silently read as "not found" cost eleven finance
 * documents being written up as missing (a different, but structurally identical, defect fixed the
 * same day in ../../legal/s3-blob-store.ts).
 */
export async function handleXeroAttachmentContent(
  input: XeroAttachmentContentInput,
  ctx: ToolContext,
  // Test-only seam — see handleXeroAttachmentUpload's identical parameter for why this is always
  // undefined in production.
  deps?: TokenDeps,
): Promise<ToolResultPayload> {
  if (!isXeroAllowed(ctx.callerAgent)) return ringRefusal('xero_attachment_content', ctx.callerAgent);
  if (!xeroConfigured()) return unconfigured('xero_attachment_content');

  const base = { org: input.org, endpoint: input.endpoint, guid: input.guid };
  const fileName = input.fileName?.trim();
  const attachmentId = input.attachmentId?.trim();
  const hasFileName = Boolean(fileName);
  const hasAttachmentId = Boolean(attachmentId);

  if (!hasFileName && !hasAttachmentId) {
    return {
      data: { ...base, identifier: null, mimeType: null, bytes: null, sha256: null, contentBase64: null, textContent: null, error: 'identifier_required' },
      summary:
        'xero_attachment_content: pass exactly one of fileName or attachmentId. Prefer attachmentId when you have it ' +
        '(it is a Xero GUID — no encoding footguns); get either from xero_attachments on the same endpoint/guid first.',
    };
  }
  if (hasFileName && hasAttachmentId) {
    return {
      data: { ...base, identifier: null, mimeType: null, bytes: null, sha256: null, contentBase64: null, textContent: null, error: 'ambiguous_identifier' },
      summary: 'xero_attachment_content: pass ONLY ONE of fileName or attachmentId, not both.',
    };
  }

  const identifier: XeroAttachmentIdentifier = hasAttachmentId
    ? { by: 'attachmentId', value: attachmentId! }
    : { by: 'fileName', value: fileName! };

  const outcome = await xeroGetAttachmentContent(input.org, input.endpoint, input.guid, identifier, { deps });
  const withId = { ...base, identifier: identifier.value };

  switch (outcome.kind) {
    case 'not_found':
      return {
        data: { ...withId, mimeType: null, bytes: null, sha256: null, contentBase64: null, textContent: null, error: 'not_found', http_status: outcome.status },
        summary:
          `NOT FOUND (HTTP 404): no attachment "${identifier.value}" on ${input.endpoint}/${input.guid} (${input.org}). ` +
          `This is DISTINCT from a permissions failure ('forbidden') — do not report the document as missing without also ` +
          `confirming with xero_attachments(org:"${input.org}", endpoint:"${input.endpoint}", guid:"${input.guid}") first. Detail: ${outcome.detail}`,
      };
    case 'forbidden':
      return {
        data: { ...withId, mimeType: null, bytes: null, sha256: null, contentBase64: null, textContent: null, error: 'forbidden', http_status: outcome.status },
        summary:
          `FORBIDDEN (HTTP 403): Xero refused this request. DISTINCT from 'not_found' — never conclude the document does ` +
          `not exist from a 403 alone. Detail: ${outcome.detail}`,
      };
    case 'auth_failed':
      return {
        data: { ...withId, mimeType: null, bytes: null, sha256: null, contentBase64: null, textContent: null, error: 'auth_failed', http_status: outcome.status },
        summary:
          `AUTH FAILED (HTTP 401, even after one forced token-refresh retry): an org-level token problem, not evidence ` +
          `about this specific attachment. Check xero_orgs(probe:true). Detail: ${outcome.detail}`,
      };
    case 'unexpected_content_type':
      return {
        data: { ...withId, mimeType: outcome.contentType, bytes: null, sha256: null, contentBase64: null, textContent: null, error: 'unexpected_content_type' },
        summary:
          `REFUSED: Xero replied with Content-Type "${outcome.contentType}" instead of the file's real type — this looks ` +
          `like the attachment-METADATA response, not the file itself, even though '*/*' was requested. Refusing to hand ` +
          `back JSON mislabeled as file content. Body preview: ${outcome.bodyPreview.slice(0, 300)}`,
      };
    case 'too_large':
      return {
        data: {
          ...withId,
          mimeType: null,
          bytes: outcome.actualBytes,
          sha256: null,
          contentBase64: null,
          textContent: null,
          error: 'content_too_large',
          content_length_header: outcome.contentLengthHeader,
          cap_bytes: outcome.cap,
        },
        summary:
          `REFUSED (nothing downloaded or returned — never truncated): the attachment is ${outcome.actualBytes ?? outcome.contentLengthHeader ?? 'over'} ` +
          `bytes, exceeding this gateway's ${outcome.cap}-byte read cap. Ask the CTO for a chunked/external channel for this file.`,
      };
    case 'xero_error':
      return {
        data: { ...withId, mimeType: null, bytes: null, sha256: null, contentBase64: null, textContent: null, error: 'xero_error', http_status: outcome.status },
        summary: `Xero returned HTTP ${outcome.status} fetching attachment content. Detail: ${outcome.detail}`,
      };
    case 'ok': {
      const sha256 = createHash('sha256').update(outcome.bytes).digest('hex');
      // Mutually exclusive by design (never both): a genuinely text file is served as textContent
      // (lossless — the same bytes, decoded) and NOT also duplicated as contentBase64, so a
      // near-cap text file cannot double its own response size past the JIT auto-offload ceiling
      // (see MAX_ATTACHMENT_READ_BYTES's comment in client.ts). A binary file gets contentBase64
      // for fidelity and textContent stays null — decoding a PDF/DOCX/scan as UTF-8 would produce
      // mojibake presented as though it were readable, the exact failure kb_get_document's
      // looksBinary check (reused here, not reimplemented) already exists to prevent.
      const isText = !looksBinary(outcome.bytes);
      return {
        data: {
          ...withId,
          mimeType: outcome.contentType,
          bytes: outcome.byteLength,
          sha256,
          contentBase64: isText ? null : outcome.bytes.toString('base64'),
          textContent: isText ? outcome.bytes.toString('utf8') : null,
        },
        summary:
          `Fetched "${identifier.value}" on ${input.endpoint}/${input.guid} (${input.org}): ${outcome.byteLength} bytes, ` +
          `${outcome.contentType}, sha256=${sha256}. ` +
          (isText
            ? 'Returned as textContent (genuinely text, byte-for-byte).'
            : 'Binary content — returned as contentBase64 for fidelity. No OCR/document-text-extraction is wired into ' +
              'this gateway for bytes fetched live from a third party; decode client-side, or route the file into the ' +
              'finance dataroom for the existing async doc-indexer/OCR sweep to produce a _TEXT/ sidecar (kb_get_document).'),
      };
    }
  }
}

function unconfigured(tool: string) {
  return {
    data: { error: 'unconfigured' },
    summary: `${tool}: Xero is not configured on this gateway (XERO_CLIENT_ID/SECRET + XERO_RT_<ORG> secrets + Cosmos required).`,
  };
}

/**
 * Compact registrar for the straightforward accounting "paged list, optional where filter" reads
 * (Contacts, Payments, CreditNotes, BankTransfers). All EXEC_RING-gated, read-only. countKey names
 * the response array to size in the summary.
 */
function registerPagedAccountingRead(
  server: McpServer,
  callerHash: CallerHashProvider,
  cfg: { name: string; title: string; description: string; path: string; countKey?: string; whereHint?: string },
): void {
  registerTool(
    server,
    {
      name: cfg.name,
      category: 'read',
      annotations: {
        title: cfg.title,
        description: cfg.countKey
          ? `${cfg.description} RESPONSE SHAPE: the array is at data.body.${cfg.countKey}, not data.${cfg.countKey} — Xero wraps every list response in an envelope and this tool passes it through verbatim; unwrapping only one level yields an empty array on every page, which reads as "not found" rather than a real absence.`
          : cfg.description,
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputShape: {
        org: ORG_ENUM,
        page: z.number().int().min(1).optional().describe('Page number (100/page). Default 1.'),
        where: z.string().optional().describe(
          `${cfg.whereHint ?? 'Optional Xero where filter.'} For completeness/duplicate/exception analysis, add Status=="AUTHORISED" — deleted/voided records are returned by default and are not excluded, which can fabricate exceptions that do not exist.`,
        ),
        modifiedAfter: z.string().optional().describe('ISO timestamp — only records modified after this (If-Modified-Since).'),
      },
      outputShape: { org: z.string(), body: z.unknown(), error: z.string().optional() },
      handler: async (input, ctx) => {
        if (!isXeroAllowed(ctx.callerAgent)) return ringRefusal(cfg.name, ctx.callerAgent);
        if (!xeroConfigured()) return unconfigured(cfg.name);
        const res = await xeroGet(
          input.org as XeroOrg,
          cfg.path,
          { page: String(input.page ?? 1), where: input.where },
          { modifiedAfter: input.modifiedAfter },
        );
        const arr = cfg.countKey ? (res.body as Record<string, unknown>)?.[cfg.countKey] : undefined;
        const count = Array.isArray(arr) ? arr.length : undefined;
        return {
          data: { org: input.org, body: res.body },
          summary: `Xero ${cfg.path.replace('/', '')} for ${input.org}, page ${input.page ?? 1}${count !== undefined ? ` (${count})` : ''}.`,
        };
      },
    },
    callerHash,
  );
}

export function registerXeroTools(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(
    server,
    {
      name: 'xero_orgs',
      category: 'read',
      annotations: {
        title: 'Xero: list orgs + connection status (executive ring only)',
        description:
          'Lists the configured Xero orgs (otchealth, innd, hearingassist, personal) and each connection status (live/dead/unbootstrapped + tenant name). MNPI-adjacent metadata: executive-ring lanes only. Never returns token material. Read-only.',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputShape: {
        probe: z
          .boolean()
          .optional()
          .describe('true = live-probe each configured org (refreshing tokens as needed). false/omitted = config-only view, no network.'),
      },
      outputShape: {
        orgs: z.array(z.unknown()),
        error: z.string().optional(),
      },
      handler: async (input, ctx) => {
        if (!isXeroAllowed(ctx.callerAgent)) return ringRefusal('xero_orgs', ctx.callerAgent);
        if (!xeroConfigured()) return unconfigured('xero_orgs');
        const configured = new Set(configuredOrgs());
        const orgs: Record<string, unknown>[] = [];
        for (const org of XERO_ORGS) {
          if (!configured.has(org)) {
            orgs.push({ org, configured: false, status: 'unbootstrapped' });
            continue;
          }
          if (!input.probe) {
            orgs.push({ org, configured: true, status: 'configured (unprobed)' });
            continue;
          }
          try {
            const a = await getOrgAccess(org);
            orgs.push({ org, configured: true, status: 'live', tenantName: a.tenantName });
          } catch (e) {
            orgs.push({ org, configured: true, status: 'dead', detail: (e as Error).message });
          }
        }
        const live = orgs.filter((o) => o.status === 'live').length;
        return {
          data: { orgs },
          summary: input.probe
            ? `Xero orgs probed: ${live}/${configured.size} live (${orgs.map((o) => `${o.org}=${o.status}`).join(', ')}).`
            : `Xero orgs configured: ${[...configured].join(', ') || '(none)'}. Pass probe:true for a live check.`,
        };
      },
    },
    callerHash,
  );

  registerTool(
    server,
    {
      name: 'xero_report',
      category: 'read',
      annotations: {
        title: 'Xero: run a financial report (executive ring only)',
        description:
          'Runs a Xero report for an org: TrialBalance (as-at date), BalanceSheet (date/periods/timeframe), ProfitAndLoss (fromDate/toDate or periods/timeframe), AgedPayablesByContact / AgedReceivablesByContact (require contactId), BankSummary (fromDate/toDate), BudgetSummary (date/periods/timeframe), ExecutiveSummary (date), TenNinetyNine (reportYear, the US 1099 report). MNPI: executive-ring lanes only. Read-only.',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputShape: {
        org: ORG_ENUM,
        report: z.enum(REPORTS).describe('Which report to run.'),
        date: z.string().optional().describe('As-at date YYYY-MM-DD (TrialBalance, BalanceSheet, Aged*).'),
        fromDate: z.string().optional().describe('Period start YYYY-MM-DD (ProfitAndLoss).'),
        toDate: z.string().optional().describe('Period end YYYY-MM-DD (ProfitAndLoss).'),
        periods: z.number().int().min(1).max(12).optional().describe('Number of comparison periods.'),
        timeframe: z.enum(['MONTH', 'QUARTER', 'YEAR']).optional().describe('Comparison period size.'),
        contactId: z.string().optional().describe('Contact GUID — REQUIRED for the Aged* reports.'),
        paymentsOnly: z.boolean().optional().describe('Cash basis (TrialBalance/P&L).'),
        reportYear: z.string().optional().describe('4-digit year — REQUIRED for TenNinetyNine (the 1099 report), e.g. "2021".'),
        nonZeroOnly: z
          .boolean()
          .optional()
          .describe('Post-fetch filter (client-side; Xero has no server-side equivalent): drop rows where every numeric column is 0.00. Most reads only need the accounts with activity, not the full chart.'),
        match: z
          .array(z.string())
          .optional()
          .describe('Post-fetch filter (client-side): keep only rows whose account/label name contains one of these strings (case-insensitive). Cheap way to pull a handful of accounts instead of paying to review the whole chart every time. NOTE: SummaryRow/total rows are dropped when this is set — Xero\'s original total includes the excluded accounts, so showing it beside a subsetted list would be misleading.'),
      },
      outputShape: {
        org: z.string(),
        report: z.string(),
        body: z.unknown(),
        day_limit_remaining: z.string().nullable().optional(),
        error: z.string().optional(),
      },
      handler: async (input, ctx) => {
        if (!isXeroAllowed(ctx.callerAgent)) return ringRefusal('xero_report', ctx.callerAgent);
        if (!xeroConfigured()) return unconfigured('xero_report');
        const org = input.org as XeroOrg;
        if (/^Aged/.test(input.report) && !input.contactId) {
          return {
            data: { org, report: input.report, body: null, error: 'contactId_required' },
            summary: `${input.report} requires contactId (Xero aged reports are per-contact).`,
          };
        }
        if (input.report === 'TenNinetyNine' && !input.reportYear) {
          return {
            data: { org, report: input.report, body: null, error: 'reportYear_required' },
            summary: 'TenNinetyNine (1099) requires reportYear, e.g. "2021".',
          };
        }
        const res = await xeroGet(org, `/Reports/${input.report}`, {
          date: input.date,
          fromDate: input.fromDate,
          toDate: input.toDate,
          periods: input.periods !== undefined ? String(input.periods) : undefined,
          timeframe: input.timeframe,
          contactID: input.contactId,
          paymentsOnly: input.paymentsOnly !== undefined ? String(input.paymentsOnly) : undefined,
          reportYear: input.reportYear,
        });
        const filtered = filterReportRows(res.body, { nonZeroOnly: input.nonZeroOnly, match: input.match });
        const filterNote = input.nonZeroOnly || input.match?.length ? ' (client-side filtered — see nonZeroOnly/match).' : '';
        return {
          data: { org, report: input.report, body: filtered, day_limit_remaining: res.dayLimitRemaining },
          summary: `Xero ${input.report} for ${org} retrieved.${filterNote}${res.dayLimitRemaining ? ` Day-limit remaining: ${res.dayLimitRemaining}.` : ''}`,
        };
      },
    },
    callerHash,
  );

  registerTool(
    server,
    {
      name: 'xero_accounts',
      category: 'read',
      annotations: {
        title: 'Xero: chart of accounts (executive ring only)',
        description: 'Full chart of accounts for an org (codes, names, types, classes). MNPI: executive-ring lanes only. Read-only.',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputShape: {
        org: ORG_ENUM,
        where: z.string().optional().describe('Optional Xero where filter, e.g. Type=="BANK".'),
      },
      outputShape: { org: z.string(), body: z.unknown(), error: z.string().optional() },
      handler: async (input, ctx) => {
        if (!isXeroAllowed(ctx.callerAgent)) return ringRefusal('xero_accounts', ctx.callerAgent);
        if (!xeroConfigured()) return unconfigured('xero_accounts');
        const res = await xeroGet(input.org as XeroOrg, '/Accounts', { where: input.where });
        const count = Array.isArray((res.body as { Accounts?: unknown[] })?.Accounts)
          ? (res.body as { Accounts: unknown[] }).Accounts.length
          : undefined;
        return {
          data: { org: input.org, body: res.body },
          summary: `Xero chart of accounts for ${input.org}${count !== undefined ? `: ${count} account(s)` : ''}.`,
        };
      },
    },
    callerHash,
  );

  registerTool(
    server,
    {
      name: 'xero_manual_journals',
      category: 'read',
      annotations: {
        title: 'Xero: manual journals (executive ring only)',
        description:
          'Manual journals for an org — paged list, or one journal by id (with lines). RESPONSE SHAPE (list mode): the array is at data.body.ManualJournals, NOT data.ManualJournals or data.body[0] — Xero wraps every list response in an envelope ({Id,Status,ProviderName,DateTimeUTC,pagination,ManualJournals:[...]}) and this tool passes that envelope through as body verbatim; unwrapping only one level yields an empty array on every page, which reads as "not found" and is dangerous for duplicate-detection work (a false "not found" can authorize posting an actual duplicate). If a paged query returns zero rows across all pages, suspect an unwrap bug before concluding absence. A boolean-style where filter such as HasAttachments is NOT reliable on this endpoint (silently returns zero for both true and false even when matching records exist) — filter that condition client-side instead. For any completeness/duplicate/exception analysis, always add Status=="AUTHORISED" to your where filter: deleted/voided journals are returned by default and are not excluded from the count, which can fabricate exceptions that do not exist. MNPI: executive-ring lanes only. Read-only.',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputShape: {
        org: ORG_ENUM,
        id: z.string().optional().describe('ManualJournal GUID for a single-journal fetch (includes lines).'),
        page: z.number().int().min(1).optional().describe('Page number (100/page). Default 1.'),
        modifiedAfter: z.string().optional().describe('ISO timestamp — only journals modified after this.'),
      },
      outputShape: { org: z.string(), body: z.unknown(), error: z.string().optional() },
      handler: async (input, ctx) => {
        if (!isXeroAllowed(ctx.callerAgent)) return ringRefusal('xero_manual_journals', ctx.callerAgent);
        if (!xeroConfigured()) return unconfigured('xero_manual_journals');
        const path = input.id ? `/ManualJournals/${encodeURIComponent(input.id)}` : '/ManualJournals';
        const res = await xeroGet(
          input.org as XeroOrg,
          path,
          input.id ? {} : { page: String(input.page ?? 1) },
          { modifiedAfter: input.modifiedAfter },
        );
        return {
          data: { org: input.org, body: res.body },
          summary: input.id
            ? `Xero manual journal ${input.id} (${input.org}) retrieved.`
            : `Xero manual journals for ${input.org}, page ${input.page ?? 1}.`,
        };
      },
    },
    callerHash,
  );

  registerTool(
    server,
    {
      name: 'xero_bank_transactions',
      category: 'read',
      annotations: {
        title: 'Xero: bank transactions (executive ring only)',
        description:
          'Bank transactions for an org — paged list, optional where filter (e.g. by bank account). RESPONSE SHAPE: the array is at data.body.BankTransactions, not data.BankTransactions (Xero wraps every list response in an envelope). For any completeness/duplicate/exception analysis, add Status=="AUTHORISED" to your where filter — deleted duplicate transactions (including duplicate large wires from a prior import event) are returned by default and are excluded from Xero\'s own bank summary but NOT from this endpoint, which fabricates exceptions that do not exist if left unfiltered. Bank-transfer legs between own accounts DO come through this endpoint as Type SPEND-TRANSFER/RECEIVE-TRANSFER; they are not a disjoint population from xero_bank_transfers. MNPI: executive-ring lanes only. Read-only.',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputShape: {
        org: ORG_ENUM,
        page: z.number().int().min(1).optional().describe('Page number (100/page). Default 1.'),
        where: z.string().optional().describe('Optional Xero where filter, e.g. BankAccount.AccountID==GUID("...").'),
        modifiedAfter: z.string().optional().describe('ISO timestamp — only transactions modified after this.'),
      },
      outputShape: { org: z.string(), body: z.unknown(), error: z.string().optional() },
      handler: async (input, ctx) => {
        if (!isXeroAllowed(ctx.callerAgent)) return ringRefusal('xero_bank_transactions', ctx.callerAgent);
        if (!xeroConfigured()) return unconfigured('xero_bank_transactions');
        const res = await xeroGet(
          input.org as XeroOrg,
          '/BankTransactions',
          { page: String(input.page ?? 1), where: input.where },
          { modifiedAfter: input.modifiedAfter },
        );
        return {
          data: { org: input.org, body: res.body },
          summary: `Xero bank transactions for ${input.org}, page ${input.page ?? 1}.`,
        };
      },
    },
    callerHash,
  );

  registerTool(
    server,
    {
      name: 'xero_invoices',
      category: 'read',
      annotations: {
        title: 'Xero: invoices (executive ring only)',
        description:
          'Invoices (AR + AP) for an org — paged list, filterable by status/number. RESPONSE SHAPE: the array is at data.body.Invoices (Xero wraps every list response in an envelope), not data.Invoices. invoiceNumber IS UNRELIABLE for cross-org or migrated-era lookups and has produced confirmed false negatives (a document later confirmed to exist via a different query). For cross-entity duplicate/AP verification, do not rely on invoiceNumber — instead use xero_get on the same org with path "/Invoices" and an explicit where clause on the field you actually posted under, e.g. where:\'Reference=="QBO-Bill-XXXXX"\'. For any completeness/duplicate/exception analysis, add Status=="AUTHORISED" to your where filter or statuses param — deleted/voided invoices are returned by default and are not excluded, which can fabricate exceptions that do not exist. MNPI: executive-ring lanes only. Read-only.',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputShape: {
        org: ORG_ENUM,
        page: z.number().int().min(1).optional().describe('Page number (100/page). Default 1.'),
        statuses: z.string().optional().describe('CSV of statuses, e.g. AUTHORISED,PAID. Include AUTHORISED explicitly when doing completeness/duplicate work — deleted/voided invoices are returned by default otherwise.'),
        invoiceNumber: z.string().optional().describe('Exact invoice number lookup. UNRELIABLE for cross-org/migrated-era invoices (confirmed false negatives) — prefer xero_get with an explicit where:\'Reference=="..."\' clause instead.'),
        modifiedAfter: z.string().optional().describe('ISO timestamp — only invoices modified after this.'),
      },
      outputShape: { org: z.string(), body: z.unknown(), error: z.string().optional() },
      handler: async (input, ctx) => {
        if (!isXeroAllowed(ctx.callerAgent)) return ringRefusal('xero_invoices', ctx.callerAgent);
        if (!xeroConfigured()) return unconfigured('xero_invoices');
        const res = await xeroGet(
          input.org as XeroOrg,
          '/Invoices',
          {
            page: String(input.page ?? 1),
            Statuses: input.statuses,
            InvoiceNumbers: input.invoiceNumber,
          },
          { modifiedAfter: input.modifiedAfter },
        );
        return {
          data: { org: input.org, body: res.body },
          summary: `Xero invoices for ${input.org}, page ${input.page ?? 1}${input.statuses ? ` (statuses: ${input.statuses})` : ''}.`,
        };
      },
    },
    callerHash,
  );

  // --- Universal read: ANY endpoint on ANY scoped Xero API (full-scope coverage backstop) ---
  registerTool(
    server,
    {
      name: 'xero_get',
      category: 'read',
      annotations: {
        title: 'Xero: universal read — any scoped endpoint (executive ring only)',
        description:
          'GET any read endpoint on any Xero API the tokens are scoped for. api = accounting (default) | payroll | assets | projects | files. path starts with "/" and is the endpoint after the base, e.g. "/Contacts", "/Reports/BankSummary", "/Payments" (accounting); "/Employees", "/PayRuns" (payroll); "/Assets" (assets); "/Projects" (projects); "/Files" (files). params is a query-string map (page, where, dates, statuses, ...). RESPONSE SHAPE: for any list endpoint, the array is nested under Xero\'s own envelope at data.body.<ResourceName> (e.g. data.body.Invoices), never at data.<ResourceName> directly. This is the reliable path for a cross-org or exact-reference lookup when a typed tool\'s own convenience filter (e.g. xero_invoices\' invoiceNumber) produces a false negative — pass params:{"where":\'Reference=="..."\'} against the resource\'s collection path instead. For completeness/duplicate/exception analysis on any endpoint, add Status=="AUTHORISED" to your where param — deleted/voided records are returned by default on most accounting endpoints. Read-only: GET only, so no path can mutate the books. MNPI: executive-ring lanes only.',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputShape: {
        org: ORG_ENUM,
        path: z.string().describe('Endpoint path starting with "/", e.g. /Contacts or /Reports/BankSummary.'),
        api: z.enum(API_ENUM).optional().describe('Which Xero API base. Default accounting.'),
        params: z.record(z.string()).optional().describe('Query params as a string map, e.g. {"page":"1"}.'),
        modifiedAfter: z.string().optional().describe('ISO timestamp -> If-Modified-Since.'),
      },
      outputShape: {
        org: z.string(),
        api: z.string(),
        path: z.string(),
        body: z.unknown(),
        day_limit_remaining: z.string().nullable().optional(),
        error: z.string().optional(),
      },
      handler: async (input, ctx) => {
        if (!isXeroAllowed(ctx.callerAgent)) return ringRefusal('xero_get', ctx.callerAgent);
        if (!xeroConfigured()) return unconfigured('xero_get');
        const path = input.path.startsWith('/') ? input.path : `/${input.path}`;
        const api = (input.api ?? 'accounting') as XeroApi;
        if (path.includes('..')) {
          return {
            data: { org: input.org, api, path, body: null, error: 'bad_path' },
            summary: 'xero_get: path must not contain "..".',
          };
        }
        const res = await xeroGet(
          input.org as XeroOrg,
          path,
          (input.params ?? {}) as Record<string, string | undefined>,
          { modifiedAfter: input.modifiedAfter, api },
        );
        return {
          data: { org: input.org, api, path, body: res.body, day_limit_remaining: res.dayLimitRemaining },
          summary: `Xero ${api} GET ${path} for ${input.org}.${res.dayLimitRemaining ? ` Day-limit remaining: ${res.dayLimitRemaining}.` : ''}`,
        };
      },
    },
    callerHash,
  );

  // --- Typed accounting reads (paged list + optional where) ---
  registerPagedAccountingRead(server, callerHash, {
    name: 'xero_contacts',
    title: 'Xero: contacts (executive ring only)',
    description:
      'Contacts (customers + suppliers) for an org — paged, filterable. Use to resolve the contactId the Aged* reports require. MNPI: executive-ring lanes only. Read-only.',
    path: '/Contacts',
    countKey: 'Contacts',
    whereHint: 'Optional Xero where filter, e.g. Name.Contains("Acme") or IsSupplier==true.',
  });
  registerPagedAccountingRead(server, callerHash, {
    name: 'xero_payments',
    title: 'Xero: payments (executive ring only)',
    description:
      'Payments (cash received + spent, applied to invoices/bills) for an org — paged, filterable. MNPI: executive-ring lanes only. Read-only.',
    path: '/Payments',
    countKey: 'Payments',
    whereHint: 'Optional Xero where filter, e.g. Status=="AUTHORISED".',
  });
  registerPagedAccountingRead(server, callerHash, {
    name: 'xero_credit_notes',
    title: 'Xero: credit notes (executive ring only)',
    description: 'Credit notes (AR + AP) for an org — paged, filterable. MNPI: executive-ring lanes only. Read-only.',
    path: '/CreditNotes',
    countKey: 'CreditNotes',
  });
  // --- BankTransfers: dedicated handler, NOT the generic registerPagedAccountingRead helper ---
  // (CFO P1-E, 2026-07-30, confirmed live): Xero's /BankTransfers endpoint does not honor `page` or
  // `where`/date filtering server-side — every call returns the org's full transfer history in one
  // shot regardless of params. This appears to be genuine vendor behavior (not a gateway bug), but a
  // document type that cannot be sized or scoped server-side is an unquantified edge for anything
  // that reasons about completeness. Fix: fetch once, then filter/paginate CLIENT-SIDE here so a
  // caller still gets a normal paged, date-bounded view instead of always eating the entire history.
  registerTool(
    server,
    {
      name: 'xero_bank_transfers',
      category: 'read',
      annotations: {
        title: 'Xero: bank transfers (executive ring only, gateway-side pagination/date-filter shim)',
        description:
          "Bank transfers (money moved between the org's own bank accounts). Xero's /BankTransfers endpoint does not support server-side pagination or date filtering (confirmed live) — this tool fetches the org's full transfer history on EVERY call (there is no caching yet — that is a real cost of this shim, not a claimed mitigation) and applies page/fromDate/toDate CLIENT-SIDE, so the caller still gets a normal bounded, date-scoped VIEW rather than the entire raw history in its response, even though the underlying fetch itself is not cheaper. RESPONSE SHAPE: the filtered array is at data.body.BankTransfers, not data.BankTransfers — this tool re-wraps its client-side-filtered slice in the same key Xero's own envelope uses, so the same one-level-short unwrap mistake that affects every other Xero list tool applies here too. total_matching/page/pages describe the FULL filtered set, not just the returned slice. MNPI: executive-ring lanes only. Read-only.",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputShape: {
        org: ORG_ENUM,
        page: z.number().int().min(1).optional().describe('Page number, 100/page, applied CLIENT-SIDE after the full fetch. Default 1.'),
        fromDate: z.string().optional().describe('YYYY-MM-DD — keep only transfers on/after this date, applied CLIENT-SIDE.'),
        toDate: z.string().optional().describe('YYYY-MM-DD — keep only transfers on/before this date, applied CLIENT-SIDE.'),
      },
      outputShape: { org: z.string(), body: z.unknown(), total_matching: z.number(), page: z.number(), pages: z.number(), error: z.string().optional() },
      handler: async (input, ctx) => {
        if (!isXeroAllowed(ctx.callerAgent)) return ringRefusal('xero_bank_transfers', ctx.callerAgent);
        if (!xeroConfigured()) return unconfigured('xero_bank_transfers');
        // VALIDATE BEFORE FETCHING (reviewer-caught, 2026-07-30): Date.parse of a malformed/
        // impossible date (e.g. "not-a-date", "2026-02-30") returns NaN, and every NaN comparison
        // below is always false — an unvalidated NaN bound would silently match everything while
        // the summary still claimed "date-filtered client-side", the exact opposite of the caller's
        // request. A real, strict YYYY-MM-DD check catches this before any network call.
        const dateRe = /^\d{4}-\d{2}-\d{2}$/;
        for (const [label, value] of [['fromDate', input.fromDate], ['toDate', input.toDate]] as const) {
          if (value === undefined) continue;
          if (!dateRe.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
            return {
              data: { org: input.org, body: null, total_matching: 0, page: 1, pages: 1, error: 'invalid_date' },
              summary: `xero_bank_transfers: ${label}="${value}" is not a valid YYYY-MM-DD date. Refused before fetching, rather than silently returning the unfiltered history.`,
            };
          }
        }
        const res = await xeroGet(input.org as XeroOrg, '/BankTransfers', {});
        const all = ((res.body as Record<string, unknown>)?.BankTransfers as Array<Record<string, unknown>>) ?? [];
        const fromMs = input.fromDate ? Date.parse(`${input.fromDate}T00:00:00Z`) : undefined;
        const toMs = input.toDate ? Date.parse(`${input.toDate}T23:59:59Z`) : undefined;
        const matching = all.filter((t) => {
          if (fromMs === undefined && toMs === undefined) return true;
          const raw = String(t.Date ?? '');
          const m = /\/Date\((\d+)/.exec(raw);
          const ms = m ? Number(m[1]) : Date.parse(raw);
          if (Number.isNaN(ms)) return true; // unparseable date: don't silently drop it, keep it
          if (fromMs !== undefined && ms < fromMs) return false;
          if (toMs !== undefined && ms > toMs) return false;
          return true;
        });
        const page = Math.max(1, input.page ?? 1);
        const pages = Math.max(1, Math.ceil(matching.length / 100));
        const slice = matching.slice((page - 1) * 100, page * 100);
        return {
          data: { org: input.org, body: { BankTransfers: slice }, total_matching: matching.length, page, pages },
          summary: `Xero bank transfers for ${input.org}: ${matching.length} matching${input.fromDate || input.toDate ? ' (date-filtered client-side)' : ''}, page ${page}/${pages}.`,
        };
      },
    },
    callerHash,
  );

  // --- Budgets ---
  registerTool(
    server,
    {
      name: 'xero_budgets',
      category: 'read',
      annotations: {
        title: 'Xero: budgets (executive ring only)',
        description:
          'Budgets for an org — list, or one budget by id (with the period breakdown). Pair with the BudgetSummary report for budget-vs-actual. MNPI: executive-ring lanes only. Read-only.',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputShape: {
        org: ORG_ENUM,
        budgetId: z.string().optional().describe('Budget GUID for a single budget (includes period lines).'),
      },
      outputShape: { org: z.string(), body: z.unknown(), error: z.string().optional() },
      handler: async (input, ctx) => {
        if (!isXeroAllowed(ctx.callerAgent)) return ringRefusal('xero_budgets', ctx.callerAgent);
        if (!xeroConfigured()) return unconfigured('xero_budgets');
        const path = input.budgetId ? `/Budgets/${encodeURIComponent(input.budgetId)}` : '/Budgets';
        const res = await xeroGet(input.org as XeroOrg, path, {});
        return {
          data: { org: input.org, body: res.body },
          summary: input.budgetId ? `Xero budget ${input.budgetId} (${input.org}).` : `Xero budgets for ${input.org}.`,
        };
      },
    },
    callerHash,
  );

  // --- Settings (organisation, tax rates, tracking, currencies, users, items, ...) ---
  registerTool(
    server,
    {
      name: 'xero_settings',
      category: 'read',
      annotations: {
        title: 'Xero: org settings (executive ring only)',
        description:
          'Read an accounting settings resource for an org: Organisation (details, base currency, financial year end), TaxRates, TrackingCategories, Currencies, Users, BrandingThemes, ContactGroups, Items. MNPI: executive-ring lanes only. Read-only.',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputShape: {
        org: ORG_ENUM,
        resource: z
          .enum(['Organisation', 'TaxRates', 'TrackingCategories', 'Currencies', 'Users', 'BrandingThemes', 'ContactGroups', 'Items'])
          .describe('Which settings resource to read.'),
      },
      outputShape: { org: z.string(), resource: z.string(), body: z.unknown(), error: z.string().optional() },
      handler: async (input, ctx) => {
        if (!isXeroAllowed(ctx.callerAgent)) return ringRefusal('xero_settings', ctx.callerAgent);
        if (!xeroConfigured()) return unconfigured('xero_settings');
        const res = await xeroGet(input.org as XeroOrg, `/${input.resource}`, {});
        return { data: { org: input.org, resource: input.resource, body: res.body }, summary: `Xero ${input.resource} for ${input.org}.` };
      },
    },
    callerHash,
  );

  // --- Attachments (source docs on a record) ---
  registerTool(
    server,
    {
      name: 'xero_attachments',
      category: 'read',
      annotations: {
        title: 'Xero: list attachments on a record (executive ring only)',
        description:
          'List the attachments (source docs) on a specific accounting record, e.g. endpoint="Invoices", guid=<InvoiceID>. Returns attachment METADATA only (filename, mime type, size, url) — NOT the file content; use xero_attachment_content for the actual bytes. Use this list to independently VERIFY an xero_attachment_upload actually persisted — its own response is not sufficient proof. MNPI: executive-ring lanes only. Read-only.',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputShape: {
        org: ORG_ENUM,
        endpoint: z
          .enum(['Invoices', 'CreditNotes', 'BankTransactions', 'BankTransfers', 'Payments', 'ManualJournals', 'Receipts', 'Contacts', 'PurchaseOrders'])
          .describe('Which record type the attachment hangs off.'),
        guid: z.string().describe('The record GUID.'),
      },
      outputShape: { org: z.string(), body: z.unknown(), error: z.string().optional() },
      handler: async (input, ctx) => {
        if (!isXeroAllowed(ctx.callerAgent)) return ringRefusal('xero_attachments', ctx.callerAgent);
        if (!xeroConfigured()) return unconfigured('xero_attachments');
        const res = await xeroGet(input.org as XeroOrg, `/${input.endpoint}/${encodeURIComponent(input.guid)}/Attachments`, {});
        return { data: { org: input.org, body: res.body }, summary: `Xero attachments on ${input.endpoint}/${input.guid} (${input.org}).` };
      },
    },
    callerHash,
  );

  // --- Attachment CONTENT (read path: the bytes, not just the metadata list above). xero_attachments
  // proves a document is attached; this actually fetches it. Distinct from xero_get/xeroGet, which
  // always requests + parses JSON and would corrupt binary content or fetch the wrong representation
  // (see xeroGetAttachmentContent's header comment in client.ts for the exact reasons). ---
  registerTool(
    server,
    {
      name: 'xero_attachment_content',
      category: 'read',
      annotations: {
        title: 'Xero: fetch an attachment\'s CONTENT (executive ring only)',
        description:
          'Fetch the actual BYTES of a source-document attachment on a Xero accounting record — the read counterpart to xero_attachment_upload. xero_attachments only lists metadata (filename/mime type/size); this tool retrieves the file itself. ' +
          'Identify the attachment with EXACTLY ONE of fileName or attachmentId (get either from xero_attachments on the same endpoint/guid first) — attachmentId (a Xero GUID) is the SAFER choice: fileName must match byte-for-byte including spaces/punctuation and needs URL-encoding, a GUID needs none. ' +
          `Cap: ${MAX_ATTACHMENT_READ_BYTES} bytes (1 MiB) — smaller than xero_attachment_upload's 10MB because this response is base64-encoded and JSON-wrapped inline; an oversized attachment is REFUSED with error:"content_too_large" (never silently truncated) rather than returned partially. ` +
          'Response carries mimeType + sha256 + byte count always; content comes back as EXACTLY ONE of textContent (genuinely text — csv/txt/xml/json exports, decoded losslessly) or contentBase64 (everything else, incl. PDF/DOCX/images, for byte-for-byte fidelity), never both. ' +
          'No OCR/document-text-extraction is wired into this gateway for bytes fetched live from Xero — a scanned PDF comes back as contentBase64 only; decode client-side, or land the file in the finance dataroom for the existing async doc-indexer/OCR sweep (then read the extracted text via kb_get_document). ' +
          'FAILURE MODES ARE DISTINCT — never assume one means another: error:"not_found" (HTTP 404, genuinely absent) vs error:"forbidden" (HTTP 403, a permissions problem, NOT evidence of absence) vs error:"auth_failed" (401 even after a forced token-refresh retry) vs error:"content_too_large" vs error:"unexpected_content_type" (Xero replied with what looks like its metadata JSON instead of the file). ' +
          'MNPI: executive-ring lanes only. Read-only.',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputShape: {
        org: ORG_ENUM,
        endpoint: z.enum(ATTACHMENT_ENDPOINT_ENUM).describe('Which record type the attachment hangs off.'),
        guid: z.string().describe('The record GUID the attachment hangs off.'),
        fileName: z.string().min(1).optional().describe('The attachment\'s exact FileName, as returned by xero_attachments. Mutually exclusive with attachmentId — pass exactly one.'),
        attachmentId: z.string().min(1).optional().describe('The attachment\'s AttachmentID (a Xero GUID), as returned by xero_attachments. PREFERRED over fileName — a GUID has no encoding footgun. Mutually exclusive with fileName — pass exactly one.'),
      },
      outputShape: {
        org: z.string(),
        endpoint: z.string(),
        guid: z.string(),
        identifier: z.string().nullable(),
        mimeType: z.string().nullable(),
        bytes: z.number().nullable(),
        sha256: z.string().nullable(),
        contentBase64: z.string().nullable(),
        textContent: z.string().nullable(),
        error: z.string().optional(),
        http_status: z.number().optional(),
        content_length_header: z.string().nullable().optional(),
        cap_bytes: z.number().optional(),
      },
      handler: handleXeroAttachmentContent,
    },
    callerHash,
  );

  // --- Attachment WRITE (fixes FND-20260724-f6df: the universal xero_request write tool always
  // sends JSON, but Xero's Attachments API requires raw file bytes + the file's real Content-Type.
  // This dedicated tool calls xeroUploadAttachment(), which sends the request correctly. ---
  registerTool(
    server,
    {
      name: 'xero_attachment_upload',
      category: 'write_simple',
      annotations: {
        title: 'Xero: upload a source-document attachment (executive ring only)',
        description:
          'Upload a source document (contract, statement, work paper) as an attachment on a Xero accounting record: endpoint="ManualJournals", guid=<JournalID>, fileName="executed-spa.pdf", contentBase64=<base64-encoded file bytes>, mimeType="application/pdf". ' +
          'This is NOT the same as xero_request — the Xero attachment API requires the raw file bytes with the correct Content-Type header, which this tool sends correctly (xero_request always sends JSON and cannot upload a real file). ' +
          '10MB cap on this gateway (Xero own limit is 25MB); for larger files, host externally and attach a link instead. ' +
          'dry_run defaults TRUE and only validates + previews (decodes and size-checks the payload without calling Xero); pass dry_run:false to actually upload. ' +
          'IMPORTANT: a 200 response from this tool is NOT sufficient proof the attachment persisted — always follow up with xero_attachments on the same endpoint/guid to independently confirm the file actually appears before reporting success. ' +
        'TRUNCATION GUARD (CFO P1-B, 2026-07-30): contentBase64 is inline, so it is emitted as MODEL OUTPUT TOKENS — the real ceiling is whatever output-token budget the calling model/subagent has left, not the 10MB documented cap, and a truncated payload has been observed to return a completely normal-looking HTTP 200 with a byte count. If you computed expected_sha256/expected_bytes from the ORIGINAL file (not from what you are about to paste), pass them: the tool decodes contentBase64 and REFUSES before ever calling Xero if the decoded bytes do not match, instead of silently uploading a truncated file that will look successful.',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputShape: {
        org: ORG_ENUM,
        endpoint: z.enum(ATTACHMENT_ENDPOINT_ENUM).describe('Which record type the attachment hangs off.'),
        guid: z.string().describe('The record GUID to attach the document to.'),
        fileName: z.string().min(1).describe('File name including extension, e.g. "executed-spa.pdf".'),
        contentBase64: z.string().min(1).describe('The file content, base64-encoded.'),
        mimeType: z.string().min(1).describe('The file\'s actual MIME type, e.g. "application/pdf", "image/png".'),
        expected_bytes: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('The ORIGINAL file size in bytes, computed BEFORE base64-encoding/pasting. If provided and the decoded contentBase64 length differs, the tool refuses with error:"truncated_payload" instead of uploading a short file.'),
        expected_sha256: z
          .string()
          .length(64)
          .optional()
          .describe('The ORIGINAL file\'s sha256 hex digest, computed BEFORE base64-encoding/pasting. If provided and it does not match the decoded contentBase64, the tool refuses with error:"truncated_payload" instead of uploading a corrupted file. Stronger than expected_bytes alone (catches a same-length corruption too).'),
      },
      outputShape: {
        org: z.string(),
        endpoint: z.string(),
        guid: z.string(),
        fileName: z.string(),
        bytes: z.number().optional(),
        sha256: z.string().optional(),
        body: z.unknown(),
        error: z.string().optional(),
      },
      handler: handleXeroAttachmentUpload,
    },
    callerHash,
  );

  // --- Payroll API (US: payroll.xro/1.0) ---
  registerTool(
    server,
    {
      name: 'xero_payroll',
      category: 'read',
      annotations: {
        title: 'Xero: payroll read (executive ring only)',
        description:
          'Read a US Payroll resource for an org: Employees, PayRuns, PayItems, PayrollCalendars, Timesheets, Settings. Optionally one by id. For any payroll endpoint not listed, use xero_get with api="payroll". MNPI: executive-ring lanes only. Read-only.',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputShape: {
        org: ORG_ENUM,
        resource: z.enum(['Employees', 'PayRuns', 'PayItems', 'PayrollCalendars', 'Timesheets', 'Settings']).describe('Which payroll resource.'),
        id: z.string().optional().describe('Resource GUID for a single-record fetch.'),
        page: z.number().int().min(1).optional().describe('Page number where the endpoint pages.'),
      },
      outputShape: { org: z.string(), body: z.unknown(), error: z.string().optional() },
      handler: async (input, ctx) => {
        if (!isXeroAllowed(ctx.callerAgent)) return ringRefusal('xero_payroll', ctx.callerAgent);
        if (!xeroConfigured()) return unconfigured('xero_payroll');
        const path = input.id ? `/${input.resource}/${encodeURIComponent(input.id)}` : `/${input.resource}`;
        const res = await xeroGet(
          input.org as XeroOrg,
          path,
          input.id ? {} : { page: input.page !== undefined ? String(input.page) : undefined },
          { api: 'payroll' },
        );
        return { data: { org: input.org, body: res.body }, summary: `Xero payroll ${input.resource}${input.id ? ` ${input.id}` : ''} for ${input.org}.` };
      },
    },
    callerHash,
  );

  // --- Assets API (fixed-asset register: assets.xro/1.0) ---
  registerTool(
    server,
    {
      name: 'xero_assets',
      category: 'read',
      annotations: {
        title: 'Xero: fixed assets (executive ring only)',
        description: 'Read the fixed-asset register for an org: Assets (by status), AssetTypes, or Settings. MNPI: executive-ring lanes only. Read-only.',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputShape: {
        org: ORG_ENUM,
        resource: z.enum(['Assets', 'AssetTypes', 'Settings']).describe('Which assets resource.'),
        status: z.enum(['DRAFT', 'REGISTERED', 'DISPOSED']).optional().describe('Asset status (Assets list; the Xero Assets API requires it — default REGISTERED).'),
        page: z.number().int().min(1).optional().describe('Page number (Assets list).'),
      },
      outputShape: { org: z.string(), body: z.unknown(), error: z.string().optional() },
      handler: async (input, ctx) => {
        if (!isXeroAllowed(ctx.callerAgent)) return ringRefusal('xero_assets', ctx.callerAgent);
        if (!xeroConfigured()) return unconfigured('xero_assets');
        const params: Record<string, string | undefined> = {};
        if (input.resource === 'Assets') {
          params.status = input.status ?? 'REGISTERED';
          if (input.page !== undefined) params.page = String(input.page);
        }
        const res = await xeroGet(input.org as XeroOrg, `/${input.resource}`, params, { api: 'assets' });
        return {
          data: { org: input.org, body: res.body },
          summary: `Xero assets ${input.resource} for ${input.org}${input.resource === 'Assets' ? ` (status ${input.status ?? 'REGISTERED'})` : ''}.`,
        };
      },
    },
    callerHash,
  );

  // --- Projects API (projects.xro/2.0) ---
  registerTool(
    server,
    {
      name: 'xero_projects',
      category: 'read',
      annotations: {
        title: 'Xero: projects (executive ring only)',
        description:
          "Read the Projects API for an org: Projects (optionally one by id), or a project's Tasks / Time entries (pass projectId). MNPI: executive-ring lanes only. Read-only.",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputShape: {
        org: ORG_ENUM,
        resource: z.enum(['Projects', 'Tasks', 'Time']).describe('Which projects resource. Tasks/Time require projectId.'),
        projectId: z.string().optional().describe('Project GUID (required for Tasks/Time).'),
        page: z.number().int().min(1).optional().describe('Page number.'),
      },
      outputShape: { org: z.string(), body: z.unknown(), error: z.string().optional() },
      handler: async (input, ctx) => {
        if (!isXeroAllowed(ctx.callerAgent)) return ringRefusal('xero_projects', ctx.callerAgent);
        if (!xeroConfigured()) return unconfigured('xero_projects');
        if ((input.resource === 'Tasks' || input.resource === 'Time') && !input.projectId) {
          return { data: { org: input.org, body: null, error: 'projectId_required' }, summary: `${input.resource} requires projectId.` };
        }
        const path = input.resource === 'Projects' ? '/Projects' : `/Projects/${encodeURIComponent(input.projectId as string)}/${input.resource}`;
        const res = await xeroGet(input.org as XeroOrg, path, { page: input.page !== undefined ? String(input.page) : undefined }, { api: 'projects' });
        return { data: { org: input.org, body: res.body }, summary: `Xero projects ${input.resource} for ${input.org}.` };
      },
    },
    callerHash,
  );

  // --- Files API (files.xro/1.0) ---
  registerTool(
    server,
    {
      name: 'xero_files',
      category: 'read',
      annotations: {
        title: 'Xero: files library (executive ring only)',
        description: 'Read the Files API for an org: Files (optionally one by id), Folders, or Associations for a file. MNPI: executive-ring lanes only. Read-only.',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputShape: {
        org: ORG_ENUM,
        resource: z.enum(['Files', 'Folders', 'Associations']).describe('Which files resource. Associations requires id (the FileId).'),
        id: z.string().optional().describe('File/Folder GUID (Associations requires the FileId).'),
        page: z.number().int().min(1).optional().describe('Page number (Files list).'),
      },
      outputShape: { org: z.string(), body: z.unknown(), error: z.string().optional() },
      handler: async (input, ctx) => {
        if (!isXeroAllowed(ctx.callerAgent)) return ringRefusal('xero_files', ctx.callerAgent);
        if (!xeroConfigured()) return unconfigured('xero_files');
        if (input.resource === 'Associations' && !input.id) {
          return { data: { org: input.org, body: null, error: 'id_required' }, summary: 'Associations requires the FileId (id).' };
        }
        let path: string;
        if (input.resource === 'Folders') path = '/Folders';
        else if (input.resource === 'Associations') path = `/Files/${encodeURIComponent(input.id as string)}/Associations`;
        else path = input.id ? `/Files/${encodeURIComponent(input.id)}` : '/Files';
        const res = await xeroGet(
          input.org as XeroOrg,
          path,
          input.resource === 'Files' && !input.id ? { pagesize: '50', page: input.page !== undefined ? String(input.page) : undefined } : {},
          { api: 'files' },
        );
        return { data: { org: input.org, body: res.body }, summary: `Xero files ${input.resource} for ${input.org}.` };
      },
    },
    callerHash,
  );

  // --- Connections metadata (CFO P0-1/P0-4, 2026-07-30): what IS this connection, and when? ---
  registerTool(
    server,
    {
      name: 'xero_connections',
      category: 'read',
      annotations: {
        title: 'Xero: raw connection metadata — id/tenant/creation date (executive ring only)',
        description:
          'Read-only GET /connections for an org: the connection id, tenant identity, and createdDateUtc/updatedDateUtc. ' +
          'PARTIAL support for the P0-1 freeze question only — this does NOT determine grandfathered eligibility for ' +
          'accounting.journals.read (grandfathered_for_journals is always null; kept in the output shape as a documented ' +
          'non-answer, not deleted). Reviewer-caught, 2026-07-30: Xero\'s documented grandfather rule ' +
          `(a connection created BEFORE ${XERO_JOURNALS_GRANDFATHER_CUTOFF} keeps journals scope until Sep 2027) applies ` +
          'specifically to CUSTOM CONNECTIONS (client_credentials grant); this gateway\'s token path uses the refresh_token/' +
          'authorization_code grant, evidence this integration is a STANDARD OAuth2 app, not a Custom Connection — and ' +
          '/connections exposes no field that identifies connection TYPE at all, so createdDateUtc alone cannot establish ' +
          'eligibility either way. Determining the real answer requires checking connection TYPE directly in the Xero ' +
          'Developer Portal / My Apps page, which no API in this tool can reach. It also CANNOT tell you which human ' +
          'authorised the connection — Xero does not expose that via any API; that fact is only visible in the Xero UI ' +
          'under Settings > Connected Apps to a user who can see the org\'s app list. Read-only: makes no changes, safe to ' +
          'call at any time, including during the P0-1 scope freeze. MNPI: executive-ring lanes only.',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputShape: { org: ORG_ENUM },
      outputShape: {
        org: z.string(),
        connections: z.array(
          z.object({
            id: z.string(),
            tenantId: z.string(),
            tenantName: z.string(),
            tenantType: z.string(),
            createdDateUtc: z.string(),
            updatedDateUtc: z.string(),
            grandfathered_for_journals: z.boolean().nullable(),
          }),
        ),
        error: z.string().optional(),
      },
      handler: async (input, ctx) => {
        if (!isXeroAllowed(ctx.callerAgent)) return ringRefusal('xero_connections', ctx.callerAgent);
        if (!xeroConfigured()) return unconfigured('xero_connections');
        const conns = await xeroConnections(input.org as XeroOrg);
        const enriched = conns.map((c) => ({ ...c, grandfathered_for_journals: isGrandfatheredForJournals(c.createdDateUtc) }));
        const summaryBits = enriched.map((c) => `${c.tenantName || c.tenantId}: created ${c.createdDateUtc || '(unknown)'}`);
        return {
          data: { org: input.org, connections: enriched },
          summary:
            `Xero connections for ${input.org}: ${summaryBits.join('; ') || '(none)'}. grandfathered_for_journals is always null — ` +
            'createdDateUtc alone cannot establish Custom Connection eligibility (see tool description); confirm connection TYPE in ' +
            'the Xero Developer Portal before acting on any grandfather assumption. "Authorising user" is also not API-exposed — check ' +
            'Settings > Connected Apps in the Xero UI for that.',
        };
      },
    },
    callerHash,
  );

  // --- xero_gl_assemble: server-side GL reconstruction (CFO P0-2, 2026-07-30) — see gl-assemble.ts
  // module doc comment for the full methodology, honest v1 scope, and the not-yet-live-verified
  // TrialBalance parsing assumption that needs a real smoke test before this is trusted blindly. ---
  registerTool(
    server,
    {
      name: 'xero_gl_assemble',
      category: 'read',
      annotations: {
        title: 'Xero: assemble the general ledger for a date range (TrialBalance period movement + ManualJournals; executive ring only)',
        description:
          'Reconstructs ledger-level detail for [from, to] WITHOUT the gated Journals endpoint, using only scopes already granted: ' +
          'reads Xero\'s own TrialBalance period movement DIRECTLY at each month-end, per account (this is vendor-computed ground ' +
          'truth — it cannot miss anything — and is NEVER diffed against another month; an earlier version of this tool diffed ' +
          'consecutive snapshots, which was arithmetically wrong, see gl-assemble.ts\'s CORRECTED module doc note), nets ManualJournals ' +
          'against those movements into a per-account `variance`, and separately returns, ' +
          'INSIDE EACH MONTH, that same month\'s gross (unsigned, NOT netted) Invoices/CreditNotes/BankTransactions line-item activity ' +
          'by account as supporting evidence. IMPORTANT — variance is ONLY a completeness proof for accounts whose movement was manual ' +
          'journals; a nonzero variance on an account that also shows activity in THAT MONTH\'S otherDocuments is EXPECTED ' +
          '(Invoices/CreditNotes/BankTransactions post to AR/AP/bank control accounts that never appear in any LineItems array, so ' +
          'netting them would look precise while silently being wrong — see the output\'s own methodology_note, and this tool\'s ' +
          'gl-assemble.ts module doc comment, for the full explanation). A month whose TrialBalance snapshot failed to parse is OMITTED ' +
          'from `months` entirely (with a caveat), never diffed — diffing a real snapshot against a failed one would fabricate a full ' +
          'balance swing that looks like a real movement. Payments/BankTransfers-as-a-source/ExpenseClaims/Receipts are not pulled in ' +
          'this version. from/to are YYYY-MM-DD and are widened to whole calendar months; EVERY source fetch (TrialBalance, ' +
          'ManualJournals, Invoices, CreditNotes, BankTransactions) uses those same widened bounds, not the raw from/to, so a ' +
          'partial-month request never diffs a full-month TB movement against a partial-month document window. One call replaces what ' +
          'would otherwise be a TrialBalance read (~295KB, ~10 JIT pages) per month, every month, forever — large results here still ' +
          'JIT-offload automatically like any other tool. Deterministic: re-running with the same org/from/to returns the same numbers. ' +
          'MNPI: executive-ring lanes only. Read-only: makes no changes.',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputShape: {
        org: ORG_ENUM,
        from: z.string().describe('Start date YYYY-MM-DD (widened to the start of that calendar month).'),
        to: z.string().describe('End date YYYY-MM-DD (widened to the end of that calendar month).'),
      },
      outputShape: {
        org: z.string(),
        from: z.string(),
        to: z.string(),
        months: z.array(z.unknown()),
        caveats: z.array(z.string()),
        methodology_note: z.string(),
        error: z.string().optional(),
      },
      handler: async (input, ctx) => {
        if (!isXeroAllowed(ctx.callerAgent)) return ringRefusal('xero_gl_assemble', ctx.callerAgent);
        if (!xeroConfigured()) return unconfigured('xero_gl_assemble');
        const result = await assembleGl(input.org as XeroOrg, input.from, input.to);
        const totalVariances = result.months.reduce((acc, m) => acc + m.nonzeroVarianceCount, 0);
        const caveatNote = result.caveats.length ? ` CAVEATS: ${result.caveats.join(' | ')}` : '';
        return {
          data: result,
          summary:
            `Xero GL assembled for ${input.org}, ${result.months.length} month(s) ${input.from}..${input.to}: ` +
            `${totalVariances} account-month(s) with nonzero manual-journal variance (see methodology_note — each month's ` +
            `Invoices/CreditNotes/BankTransactions activity is in that month's own otherDocuments).${caveatNote}`,
        };
      },
    },
    callerHash,
  );

  // --- Universal WRITE: POST/PUT/DELETE any scoped endpoint (the CFO write lane; Matt-authorized) ---
  registerTool(
    server,
    {
      name: 'xero_request',
      category: 'write_simple',
      annotations: {
        title: 'Xero: write — POST/PUT/DELETE any scoped endpoint (executive ring only)',
        description:
          'Create / update / void on any Xero API the tokens are scoped for (the CFO write lane). method = POST | PUT | DELETE. api = accounting (default) | payroll | assets | projects | files. path starts with "/", e.g. "/Invoices", "/Contacts", "/Payments", "/ManualJournals", "/BankTransactions", "/CreditNotes", "/Accounts". body is the JSON payload — for accounting collections wrap in the plural key, e.g. {"Invoices":[{...}]}. Xero writes are BOOKKEEPING (they post to the ledger, they do NOT move real money). dry_run defaults TRUE and previews without sending; pass dry_run:false to actually write. Do NOT use this for attachment uploads — the Xero Attachments API needs raw file bytes with the file\'s Content-Type, which this JSON-only tool cannot send; use xero_attachment_upload instead. MNPI: executive-ring lanes only.',
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
      inputShape: {
        org: ORG_ENUM,
        method: z.enum(['POST', 'PUT', 'DELETE']).describe('POST = create/update, PUT = create-if-absent, DELETE where Xero supports it.'),
        path: z.string().describe('Endpoint path starting with "/", e.g. /Invoices or /Contacts.'),
        api: z.enum(API_ENUM).optional().describe('Which Xero API base. Default accounting.'),
        body: z.unknown().optional().describe('JSON payload. For accounting collections wrap in the plural key, e.g. {"Invoices":[{...}]}.'),
        params: z.record(z.string()).optional().describe('Query params as a string map, e.g. {"summarizeErrors":"false"}.'),
        allow_duplicate: z
          .boolean()
          .optional()
          .describe(
            'Deliberately permit a create whose Reference already exists in this org. Default false. ' +
              'The guard exists because a census found 49 phantom duplicate objects (13 bills as FOUR objects each) ' +
              'produced by repeated creates against the same Reference. Use ONLY for a reviewed, intentional second object.',
          ),
      },
      outputShape: {
        org: z.string(),
        method: z.string(),
        api: z.string(),
        path: z.string(),
        body: z.unknown(),
        day_limit_remaining: z.string().nullable().optional(),
        error: z.string().optional(),
        // Declared so zod does not STRIP them: an undeclared field never reaches the caller, which
        // would silently recreate the exact "bare error code, no detail" problem these fields fix.
        refusal_detail: z.string().optional(),
        missing: z.array(z.object({ item: z.number(), missing: z.array(z.string()) })).optional(),
      },
      handler: async (input, ctx) => {
        if (!isXeroAllowed(ctx.callerAgent)) return ringRefusal('xero_request', ctx.callerAgent);
        if (!xeroConfigured()) return unconfigured('xero_request');
        const path = input.path.startsWith('/') ? input.path : `/${input.path}`;
        const api = (input.api ?? 'accounting') as XeroApi;
        if (path.includes('..')) {
          return {
            data: { org: input.org, method: input.method, api, path, body: null, error: 'bad_path' },
            summary: 'xero_request: path must not contain "..".',
          };
        }
        // --- WRITE GUARD (2026-08-14 duplicate-object incident). Runs BEFORE the dry-run return so
        // a dry run also reports what the guard would do, making it a real preview. See
        // write-guard.ts for the census that motivated each check.
        if (api === 'accounting') {
          // 1. MAP BY IDENTITY, NOT BY CODE. Account codes are per-org and Xero silently
          //    re-resolves them in the destination org, which is how one document landed in both
          //    the INND and HearingAssist ledgers.
          const violations = findAccountCodeViolations(input.body);
          if (violations.length) {
            const where = violations
              .slice(0, 5)
              .map((v) => `item[${v.itemIndex}].LineItems[${v.lineIndex}] AccountCode=${v.accountCode}`)
              .join('; ');
            return {
              data: { org: input.org, method: input.method, api, path, body: null, error: 'account_code_not_permitted' },
              summary:
                `REFUSED (${violations.length} line item(s) identify the account by CODE, not AccountID): ${where}. ` +
                'Account codes are per-org and Xero re-resolves them locally, so the same code reaches an unrelated ' +
                'account in another org (1251 is "Due from HearingAssist Inc" in INND but "Star Funding - AR" in ' +
                'HearingAssist). Resolve each account to its AccountID in the DESTINATION org and resend.',
            };
          }

          // 2. NO DUPLICATE CREATES. Read-before-write on the natural key, fail CLOSED.
          if (isCreate(input.method, path) && !input.allow_duplicate) {
            const collection = collectionOf(path);
            const items = unwrapItems(input.body, collection);
            const keys = items.map((item) => naturalKeyOf(item, collection));
            if (!items.length || keys.some((k) => k === null)) {
              // A ManualJournal has no Reference/InvoiceNumber/CreditNoteNumber and never can, so
              // the generic "add a Reference" advice is unactionable there. Name the missing parts
              // of the Narration+Date+Total key instead -- a refusal the caller can actually fix.
              const mjGaps =
                collection === 'manualjournals'
                  ? items
                      .map((item, i) => ({ i, gaps: manualJournalKeyGaps(item) }))
                      .filter((g) => g.gaps.length)
                  : [];
              const detail = mjGaps.length
                ? `${mjGaps.length} manual journal(s) lack a complete Narration+Date+Total key: ` +
                  mjGaps.map((g) => `item[${g.i}] missing ${g.gaps.join(' + ')}`).join('; ') +
                  '. A ManualJournal has no Reference field, so Narration + Date + Total IS its natural key ' +
                  '(the same key our duplicate census grouped on when it found 17 duplicate journal groups). ' +
                  'Supply all three and resend.'
                : `${items.length} item(s), ` +
                  `${keys.filter((k) => k === null).length} without a Reference/InvoiceNumber/CreditNoteNumber. ` +
                  'Every create on this collection needs a natural key so existence can be checked first. ' +
                  'Add a Reference, or pass allow_duplicate:true to record a deliberate second object.';
              return {
                // `refusal_detail` and `missing` are in the STRUCTURED payload, not only in the prose
                // summary (2026-08-17). The CFO ran a correct A/B test -- a complete key versus one
                // missing its Narration -- and reported both as "byte-identical bare
                // unverifiable_create with no field named". They were reading `data`, where the two
                // ARE identical; the discriminator existed only in `summary`, which their client does
                // not surface. A refusal that cannot be told apart from a different refusal by the
                // client receiving it is not actionable, however good the prose is.
                data: {
                  org: input.org,
                  method: input.method,
                  api,
                  path,
                  body: null,
                  error: 'unverifiable_create',
                  refusal_detail: detail,
                  missing: mjGaps.length ? mjGaps.map((g) => ({ item: g.i, missing: g.gaps })) : undefined,
                },
                summary: `REFUSED (cannot verify this create is not a duplicate): ${detail}`,
              };
            }
            const found: string[] = [];
            for (const key of keys) {
              if (!key) continue;
              let probe;
              try {
                probe = await xeroGet(input.org as XeroOrg, `/${collection}`, { where: existsFilterFor(key) }, { api });
              } catch (e) {
                return {
                  data: { org: input.org, method: input.method, api, path, body: null, error: 'probe_failed' },
                  summary:
                    `REFUSED (existence probe failed, failing closed): ${key.field}="${key.value}" — ` +
                    `${e instanceof Error ? e.message : String(e)}. During a duplicate-object incident an ` +
                    'unverifiable write is refused rather than risked. Retry, or pass allow_duplicate:true.',
                };
              }
              // Narration+Date narrowed the candidates server-side; Total decides. Without this
              // refine, two legitimately distinct journals sharing a narration on the same date
              // (a recurring accrual, say) would block each other.
              const existing =
                key.kind === 'manual_journal'
                  ? readExisting(collection, probe.body).filter((x) => manualJournalMatches(x.total, key.total))
                  : readExisting(collection, probe.body);
              if (blocksCreate(existing.map((x) => x.status))) {
                found.push(
                  `${key.field}="${key.value}" already exists as ${existing.length} object(s): ` +
                    existing.map((x) => `${x.id}${x.status ? ` (${x.status})` : ''}`).join(', '),
                );
              }
            }
            if (found.length) {
              return {
                data: {
                  org: input.org,
                  method: input.method,
                  api,
                  path,
                  body: null,
                  error: 'duplicate_create_blocked',
                  // Same reasoning as unverifiable_create above: the existing object IDs are the
                  // actionable part of this refusal and must not live only in prose.
                  refusal_detail: found.join(' | '),
                },
                summary:
                  `REFUSED (would create duplicate object(s) in ${input.org}): ${found.join(' | ')}. ` +
                  'VOIDED and DELETED objects still block: re-creating against a voided copy is exactly how one ' +
                  'bill reached four objects. To reverse an object use a reversing entry, never a re-create. ' +
                  'Pass allow_duplicate:true only for a deliberate, reviewed second object.',
              };
            }
          }
        }

        if (ctx.dryRun) {
          return {
            data: { org: input.org, method: input.method, api, path, body: null, error: 'dry_run' },
            summary: `DRY RUN (nothing written): ${input.method} ${api} ${path} for ${input.org}. Write guard passed. Re-call with dry_run:false to execute.`,
          };
        }
        const res = await xeroRequest(
          input.org as XeroOrg,
          input.method,
          path,
          input.body,
          (input.params ?? {}) as Record<string, string | undefined>,
          { api },
        );
        return {
          data: { org: input.org, method: input.method, api, path, body: res.body, day_limit_remaining: res.dayLimitRemaining },
          summary: `Xero ${input.method} ${api} ${path} for ${input.org} — HTTP ${res.status}.${res.dayLimitRemaining ? ` Day-limit remaining: ${res.dayLimitRemaining}.` : ''}`,
        };
      },
    },
    callerHash,
  );
}
