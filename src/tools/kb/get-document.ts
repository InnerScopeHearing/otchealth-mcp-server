/**
 * kb_get_document — ring-gated WHOLE-DOCUMENT retrieval for the privileged finance dataroom.
 *
 * WHY (CFO P1, 2026-07-17): brain_search / kb_search_privileged return ranked SNIPPETS. For the
 * autonomous FY2021 close the CFO must pull COMPLETE files (a 64-row note register, a multi-year
 * price series) with a completeness PROOF — a census that must tie to the dollar cannot be
 * stitched from overlapping search snippets. This tool returns the full text of a named blob from
 * the finance dataroom, paginated, with total_chars / total_lines / sha256 so the caller can prove
 * it received the whole document.
 *
 * RING: identical boundary to kb_search_privileged — `isLaneAllowed(index, caller)` with the SAME
 * INDEX_LANES map (EXEC_RING on the finance rooms; the broad 'cto'/external connector identity is
 * excluded by construction). Federation/fetch must never become a side door around a privilege
 * boundary, so the ring predicate is imported, never re-implemented.
 *
 * LEGAL rooms are NOT served here on purpose: whole-document retrieval for legal already exists as
 * legal_blob_get (container-level ring gates, incl. the narrower personal-legal ring). One tool per
 * store keeps each ring auditable in one place.
 *
 * STORE MAPPING: both finance indexes are built by the doc-indexer `finance` profile over the SAME
 * physical store — account otchealthcfodata, container cfo-source-docs (the
 * "finance-otchealth-cfo-source-docs" index name carries the legacy GCS bucket name from the
 * 2026-06 migration; the blobs live in the one Azure container). Text sidecars live under _TEXT/.
 */
import crypto from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { loadEnv } from '../../config/env.js';
import { fetchBlobRaw } from '../../legal/blob-store.js';
import { isLaneAllowed } from './search-privileged.js';

/** Finance indexes served by this tool -> the one physical container behind both. */
export const FINANCE_DOC_INDEXES = ['finance-cfo-source-docs', 'finance-otchealth-cfo-source-docs'] as const;
const CONTAINER = 'cfo-source-docs';

/** Page size in characters. 60k chars ≈ well under the MCP payload comfort zone while keeping a
 *  64-row register or a year of price rows in very few pages. */
export const PAGE_CHARS = 60_000;

/** Hard cap on the blob size we will load (the largest _TEXT sidecars are tens of MB; a runaway
 *  video/binary must not OOM the gateway). */
const MAX_BYTES = 50 * 1024 * 1024;

/** Path hygiene: container-relative, no traversal, no absolute/URL forms. Pure + exported for tests. */
export function isSafeBlobPath(path: string): boolean {
  if (!path || path.length > 1024) return false;
  if (path.startsWith('/') || path.includes('\\')) return false;
  if (path.includes('..')) return false;
  if (/^[a-z]+:\/\//i.test(path)) return false;
  return true;
}

/** Where the doc-indexer writes extracted text for a source blob: `_TEXT/<path>.txt`. */
export const TEXT_PREFIX = '_TEXT/';
export function sidecarPathFor(path: string): string {
  return `${TEXT_PREFIX}${path}.txt`;
}

/**
 * Accept the path form the SEARCH TOOLS EMIT, not only the container-relative form this store wants.
 *
 * THE DEFECT THIS CLOSES (CFO escalation 2026-08-17: "10 of 10 attempts failed"). The finance search
 * indexes store each document's path FULLY QUALIFIED, as `<account>/<container>/<blob path>` --
 * e.g. `otchealthcfodata/cfo-source-docs/mail-archive-attachments/.../TrialBalance_2019.xlsx`.
 * fetchBlobRaw takes a path RELATIVE TO THE CONTAINER. So a path copied verbatim out of a
 * kb_search_privileged hit -- the single most natural thing a caller can do, and exactly what the
 * two tools' descriptions invite -- resolved to
 * `cfo-source-docs/otchealthcfodata/cfo-source-docs/...` and could NEVER be found.
 *
 * That is why the failure was 10-of-10 rather than intermittent: the two tools speak different path
 * dialects, so the round-trip is broken by construction. It is not a caller guessing paths.
 *
 * The cost was not a missing feature. The documents were present and readable the whole time --
 * verified live: stripping the prefix returns the file with pages=1. The CFO recorded FY2022 figures
 * as "characterised" rather than derived BECAUSE the evidence appeared unreachable. A retrieval tool
 * that answers `found:false` for a document that exists produces false negatives, and a false
 * negative in a fiscal close reads as a finding.
 *
 * Deliberately an EXACT-PREFIX strip, not "drop the first two segments": a blindly-positional strip
 * would silently mangle a legitimately container-relative path whose first two segments happen to
 * look like an account and container. Only the known `<account>/<container>/` for THIS store is
 * removed, so every path that already worked keeps working byte-identically.
 */
export function toContainerRelative(path: string, account: string, container: string): string {
  const qualified = `${account}/${container}/`;
  if (path.startsWith(qualified)) return path.slice(qualified.length);
  // Also tolerate a container-qualified path with the account omitted, which is how some callers
  // and older index rows shorten it.
  const containerOnly = `${container}/`;
  if (path.startsWith(containerOnly)) return path.slice(containerOnly.length);
  return path;
}

/**
 * Is this buffer a binary file rather than readable text?
 *
 * THE DEFECT THIS CLOSES: the handler used to do `res.buf.toString('utf8')` unconditionally. Handing
 * that a PDF, DOCX or scanned statement produced MOJIBAKE, and the tool returned found:true with a
 * confident char count, line count and sha256 -- presenting binary noise to the CFO as though it
 * were the document's contents. A confident wrong answer is worse than a refusal, especially on a
 * source document being used to close a fiscal year.
 *
 * A NUL byte is the decisive tell: valid UTF-8 text never contains one, while PDF/ZIP (docx/xlsx)/
 * legacy-Office/image containers all do. Magic numbers are checked first so the common finance
 * formats are named explicitly in the error rather than reported as a generic "binary".
 */
export function looksBinary(buf: Buffer): boolean {
  if (buf.length === 0) return false;
  if (buf.length >= 4) {
    const magic = buf.subarray(0, 4);
    if (magic.toString('latin1') === '%PDF') return true;
    if (magic[0] === 0x50 && magic[1] === 0x4b && (magic[2] === 0x03 || magic[2] === 0x05 || magic[2] === 0x07)) return true; // ZIP: docx/xlsx/pptx
    if (magic[0] === 0xd0 && magic[1] === 0xcf) return true; // legacy OLE2: .doc/.xls
    if (magic[0] === 0x89 && magic.subarray(1, 4).toString('latin1') === 'PNG') return true;
    if (magic[0] === 0xff && magic[1] === 0xd8) return true; // JPEG
  }
  // A NUL anywhere in the leading window means this is not text.
  return buf.subarray(0, Math.min(buf.length, 8192)).includes(0);
}

/** Pure pagination helper, exported for tests. */
export function paginate(text: string, page: number): {
  content: string;
  page: number;
  total_pages: number;
  total_chars: number;
  total_lines: number;
} {
  const total_chars = text.length;
  const total_pages = Math.max(1, Math.ceil(total_chars / PAGE_CHARS));
  const p = Math.min(Math.max(1, page), total_pages);
  const start = (p - 1) * PAGE_CHARS;
  const content = text.slice(start, start + PAGE_CHARS);
  // Count lines the way `wc -l`-minded auditors expect: newline count, +1 when there is a final
  // unterminated line. Empty doc = 0 lines.
  let nl = 0;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) nl++;
  const total_lines = total_chars === 0 ? 0 : nl + (text.endsWith('\n') ? 0 : 1);
  return { content, page: p, total_pages, total_chars, total_lines };
}

export function registerKbGetDocument(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(
    server,
    {
      name: 'kb_get_document',
      category: 'read',
      annotations: {
        title: 'Fetch a WHOLE document from the ring-gated finance dataroom (paginated)',
        description:
          'Ring-gated WHOLE-document retrieval from the finance dataroom (account otchealthcfodata/cfo-source-docs — the blobs behind the finance-* search indexes). Search returns snippets; this returns the complete file, paginated, with total_chars/total_lines/sha256 as a completeness proof (an audit census must tie to the dollar). index = "finance-cfo-source-docs" or "finance-otchealth-cfo-source-docs" (same store). path = the blob path, e.g. "_TEXT/innd-stock/INND-daily-stock-history.xlsx.txt". Ring-gated to the executive ring exactly like kb_search_privileged; MNPI, internal-only, read-only. For legal rooms use legal_blob_get.',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputShape: {
        index: z.enum(FINANCE_DOC_INDEXES).describe('Which finance index namespace (both map to the same physical store).'),
        path: z.string().min(1).describe('Blob path within the store, e.g. "_TEXT/innd-stock/INND-daily-stock-history.xlsx.txt".'),
        page: z.number().int().min(1).optional().describe('1-based page of PAGE_CHARS=60000 characters. Default 1.'),
      },
      outputShape: {
        index: z.string(),
        path: z.string(),
        found: z.boolean(),
        page: z.number(),
        total_pages: z.number(),
        total_chars: z.number(),
        total_lines: z.number(),
        sha256: z.string().nullable(),
        content: z.string().nullable(),
        error: z.string().optional(),
      },
      handler: async (input, ctx) => {
        const index = input.index;
        const path = input.path.trim();
        const page = input.page ?? 1;
        const caller = ctx.callerAgent || '';
        const empty = { index, path, found: false, page: 1, total_pages: 0, total_chars: 0, total_lines: 0, sha256: null, content: null };

        if (!isLaneAllowed(index, caller)) {
          return {
            data: { ...empty, error: 'forbidden_ring' },
            summary: `Refused: "${index}" is ring-gated (MNPI). Your identity: ${caller || '(none)'}. Privileged finance documents are never served outside the executive ring.`,
          };
        }
        if (!isSafeBlobPath(path)) {
          return { data: { ...empty, error: 'invalid_path' }, summary: 'Refused: path must be container-relative with no traversal.' };
        }
        const env = loadEnv();
        if (!env.AZURE_CFO_STORAGE_KEY) {
          return { data: { ...empty, error: 'unconfigured' }, summary: 'Finance store not configured (AZURE_CFO_STORAGE_KEY unset).' };
        }
        // Normalise the SEARCH-EMITTED form (<account>/<container>/<blob path>) to the
        // container-relative form this store takes. See toContainerRelative: without this, a path
        // copied verbatim out of a kb_search_privileged hit can never resolve.
        const relPath = toContainerRelative(path, env.AZURE_CFO_STORAGE_ACCOUNT, CONTAINER);
        try {
          const res = await fetchBlobRaw(env.AZURE_CFO_STORAGE_ACCOUNT, env.AZURE_CFO_STORAGE_KEY, CONTAINER, relPath);
          if (!res.found || !res.buf) {
            return { data: empty, summary: `No blob at ${CONTAINER}/${relPath}. Tip: text sidecars live under _TEXT/ and end in .txt.` };
          }
          if (res.buf.length > MAX_BYTES) {
            return {
              data: { ...empty, error: 'too_large' },
              summary: `Blob is ${res.buf.length} bytes (> ${MAX_BYTES} cap). Ask the CTO for a chunked export of this file.`,
            };
          }
          // A binary source blob (PDF/DOCX/scanned statement) is NOT readable content. Serve its
          // extracted-text sidecar instead of decoding the bytes as UTF-8 and calling it a document.
          let buf = res.buf;
          let servedPath = relPath;
          let viaSidecar = false;
          if (looksBinary(buf) && !path.startsWith(TEXT_PREFIX)) {
            const sidecar = sidecarPathFor(relPath);
            const alt = await fetchBlobRaw(env.AZURE_CFO_STORAGE_ACCOUNT, env.AZURE_CFO_STORAGE_KEY, CONTAINER, sidecar);
            if (alt.found && alt.buf && !looksBinary(alt.buf)) {
              buf = alt.buf;
              servedPath = sidecar;
              viaSidecar = true;
            } else {
              // Refuse rather than return mojibake. The caller is told exactly why and what to do,
              // because "unreadable" and "not yet extracted" need different follow-ups.
              return {
                data: { ...empty, error: 'binary_no_text' },
                summary:
                  `${CONTAINER}/${path} is a BINARY document (${res.buf.length} bytes), not text, and no extracted-text ` +
                  `sidecar exists yet at ${CONTAINER}/${sidecar}. Returning nothing rather than decoding the bytes as ` +
                  `UTF-8, which would look like content but be garbage. Text extraction is asynchronous: attachments ` +
                  `saved via mail_archive_save_attachment_to_dataroom are indexed by the doc-indexer/OCR sweep on a ` +
                  `later run, not at save time. Retry after the next sweep, or ask the CTO to run the indexer on this ` +
                  `prefix. To fetch the raw bytes for download, use the blob path directly.`,
              };
            }
          }
          const text = buf.toString('utf8');
          const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
          const pageData = paginate(text, page);
          return {
            data: { index, path: servedPath, found: true, ...pageData, sha256, content: pageData.content },
            summary:
              `${CONTAINER}/${servedPath}: page ${pageData.page}/${pageData.total_pages}, ${pageData.total_chars} chars, ${pageData.total_lines} lines total, sha256=${sha256.slice(0, 12)}… (lane=${caller}). Counts + hash are the completeness proof.` +
              (viaSidecar ? ` NOTE: "${path}" is a binary document; this is its extracted-text sidecar, so the hash is of the TEXT, not the original file.` : ''),
          };
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return { data: { ...empty, error: msg }, summary: `Fetch failed: ${msg}` };
        }
      },
    },
    callerHash,
  );
}
