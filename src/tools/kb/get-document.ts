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
        try {
          const res = await fetchBlobRaw(env.AZURE_CFO_STORAGE_ACCOUNT, env.AZURE_CFO_STORAGE_KEY, CONTAINER, path);
          if (!res.found || !res.buf) {
            return { data: empty, summary: `No blob at ${CONTAINER}/${path}. Tip: text sidecars live under _TEXT/ and end in .txt.` };
          }
          if (res.buf.length > MAX_BYTES) {
            return {
              data: { ...empty, error: 'too_large' },
              summary: `Blob is ${res.buf.length} bytes (> ${MAX_BYTES} cap). Ask the CTO for a chunked export of this file.`,
            };
          }
          const text = res.buf.toString('utf8');
          const sha256 = crypto.createHash('sha256').update(res.buf).digest('hex');
          const pageData = paginate(text, page);
          return {
            data: { index, path, found: true, ...pageData, sha256, content: pageData.content },
            summary: `${CONTAINER}/${path}: page ${pageData.page}/${pageData.total_pages}, ${pageData.total_chars} chars, ${pageData.total_lines} lines total, sha256=${sha256.slice(0, 12)}… (lane=${caller}). Counts + hash are the completeness proof.`,
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
