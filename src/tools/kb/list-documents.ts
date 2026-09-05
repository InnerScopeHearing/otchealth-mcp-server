/**
 * kb_list_documents — ring-gated PREFIX LISTING over the finance/legal dataroom key spaces
 * (GitHub issue #292).
 *
 * WHY: kb_search_privileged / kb_search returns ranked snippets; kb_get_document returns one named
 * document's full text. Neither answers "what keys exist under this prefix" — the exact question
 * the CFO needs answered to settle whether a batch of originals (e.g. a bank's statement export)
 * was actually ingested into the dataroom, independent of whether it was ever indexed for search.
 * No existing gateway tool lists finance keys at all; legal_blob_list does this for the two legal
 * containers only.
 *
 * RING: identical boundary to kb_search_privileged for the SAME index name — this tool's `index`
 * enum is a strict subset of kb_search_privileged's INDEX_LANES keys, and `isLaneAllowed` is
 * imported (never re-implemented) so the two can never silently drift apart. finance-* -> EXEC_RING,
 * legal-personal -> the narrower PERSONAL_LEGAL_RING, legal-company -> EXEC_RING. The broad
 * cto/default/external connector identity is refused, exactly like every other privileged tool.
 *
 * BACKEND: reuses the exact same list functions legal_blob_list's listBlobs() reuses internally —
 * listBlobsFromS3 (the S3 mirror, active whenever BLOB_BACKEND=s3, which is also what routes
 * finance reads in kb_get_document / legal reads in legal_blob_get) or blob-store.ts's Azure-native
 * listBlobs() for the two LegalContainer values when BLOB_BACKEND=azure. There is no generic Azure
 * list route for an arbitrary (account, container) pair — only the two legal containers have one —
 * so a finance listing under BLOB_BACKEND=azure fails loud with a clear next step rather than
 * guessing at an unbuilt Azure call. See s3-blob-store.ts's MIRROR table: the finance room
 * (otchealthcfodata/cfo-source-docs) and both legal containers are all present.
 *
 * TEXT SIDECAR FLAG: the doc-indexer writes extracted text for a binary source blob to
 * `_TEXT/<path>.txt` (see get-document.ts's TEXT_PREFIX / sidecarPathFor — reused here, not
 * redeclared). `_TEXT/` entries are excluded from the main listing (they are indexer artifacts, not
 * source documents) but a second listing of the `_TEXT/` + prefix subtree is used to compute
 * `has_text_sidecar` per key in one extra list call rather than a per-key HEAD.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { loadEnv } from '../../config/env.js';
import { listBlobs, type LegalContainer } from '../../legal/blob-store.js';
import { listBlobsFromS3, s3BlobBackendActive } from '../../legal/s3-blob-store.js';
import { isLaneAllowed } from './search-privileged.js';
import { TEXT_PREFIX } from './get-document.js';

/** The four dataroom indexes this tool serves. A strict subset of kb_search_privileged's
 *  INDEX_LANES keys — legal-personal-memory / finance-cfo-memory are memory feeds, not document
 *  key spaces, and are deliberately not listable here. */
export const KB_LIST_INDEXES = [
  'finance-cfo-source-docs',
  'finance-otchealth-cfo-source-docs',
  'legal-company',
  'legal-personal',
] as const;
export type KbListIndex = (typeof KB_LIST_INDEXES)[number];

/** Both finance index names map to the SAME physical store (see get-document.ts's header — the
 *  "otchealth-cfo-source-docs" name carries the legacy GCS bucket name from the 2026-06 migration). */
const FINANCE_CONTAINER = 'cfo-source-docs';

export interface RawListRow {
  name: string;
  size: number | null;
  lastModified: string | null;
}

export interface ListedItem {
  key: string;
  size: number | null;
  last_modified: string | null;
  has_text_sidecar: boolean;
}

/** Resolve the (account, container) an index is served from. Pure aside from the env read. */
export function storeFor(index: KbListIndex): { account: string; container: string } {
  const env = loadEnv();
  switch (index) {
    case 'finance-cfo-source-docs':
    case 'finance-otchealth-cfo-source-docs':
      return { account: env.AZURE_CFO_STORAGE_ACCOUNT, container: FINANCE_CONTAINER };
    case 'legal-company':
      return { account: env.AZURE_LEGAL_STORAGE_ACCOUNT, container: 'company' };
    case 'legal-personal':
      return { account: env.AZURE_LEGAL_STORAGE_ACCOUNT, container: 'personal' };
  }
}

/**
 * List raw rows under `prefix` for (account, container) — the SAME backend split legal_blob_list's
 * listBlobs() already makes: the S3 mirror when active, else Azure-native listBlobs() for the two
 * legal containers. Not a generic Azure lister: a finance listing on BLOB_BACKEND=azure has no
 * built Azure route and fails loud rather than silently returning nothing.
 */
export async function listStoreBlobs(
  account: string,
  container: string,
  prefix: string | undefined,
): Promise<RawListRow[]> {
  if (s3BlobBackendActive()) {
    const rows = await listBlobsFromS3(account, container, prefix);
    return rows.map((r) => ({ name: r.name, size: r.size, lastModified: r.lastModified }));
  }
  if (container === 'company' || container === 'personal') {
    const rows = await listBlobs(container as LegalContainer, prefix);
    return rows.map((r) => ({ name: r.name, size: r.size, lastModified: r.lastModified }));
  }
  throw new Error(
    `no Azure list route for ${account}/${container} (BLOB_BACKEND=azure). Finance listings require BLOB_BACKEND=s3.`,
  );
}

/**
 * Combine a main listing + a `_TEXT/`-subtree listing into the final item shape: excludes any
 * `_TEXT/`-prefixed row from the main set (indexer artifacts, not source documents), computes
 * has_text_sidecar per key by checking whether `_TEXT/<key>.txt` appeared in the sidecar listing,
 * applies the optional case-insensitive `contains` substring filter, and sorts by key for stable
 * pagination. Pure — the whole reason listStoreBlobs and this are separate functions is so this,
 * the actual logic, is testable without a live store.
 */
export function buildListing(mainRows: RawListRow[], textRows: RawListRow[], contains?: string): ListedItem[] {
  const textNames = new Set(textRows.map((r) => r.name));
  let items: ListedItem[] = mainRows
    .filter((r) => !r.name.startsWith(TEXT_PREFIX))
    .map((r) => ({
      key: r.name,
      size: r.size,
      last_modified: r.lastModified,
      has_text_sidecar: textNames.has(`${TEXT_PREFIX}${r.name}.txt`),
    }));
  if (contains) {
    const needle = contains.toLowerCase();
    items = items.filter((i) => i.key.toLowerCase().includes(needle));
  }
  return items.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/**
 * Offset-style paging over an already-fully-enumerated listing. listStoreBlobs (via listBlobsFromS3
 * / blob-store.ts's listBlobs) exhausts the underlying store's own pagination internally (bounded at
 * 200 pages), so by the time buildListing runs there is no live cursor left to hand back — hence a
 * plain stringified array offset rather than the store's native continuation token. Documented here
 * because it is the one place this tool's `continuation` semantics differ from a token that means
 * something to the backing store itself.
 */
export function paginateItems(
  items: ListedItem[],
  max: number,
  continuation?: string | null,
): { page: ListedItem[]; next: string | null; truncated: boolean } {
  const offset = continuation ? Math.max(0, Number.parseInt(continuation, 10) || 0) : 0;
  const page = items.slice(offset, offset + max);
  const truncated = offset + page.length < items.length;
  const next = truncated ? String(offset + page.length) : null;
  return { page, next, truncated };
}

export function registerKbListDocuments(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(
    server,
    {
      name: 'kb_list_documents',
      category: 'read',
      annotations: {
        title: 'List keys in a ring-gated finance/legal dataroom by prefix',
        description:
          'List blob KEYS (not content) under an optional prefix in a ring-gated finance or legal dataroom — the same stores behind kb_search_privileged / kb_get_document / legal_blob_get, answering "what exists here" independent of what got indexed for search. index = finance-cfo-source-docs, finance-otchealth-cfo-source-docs (same physical store), legal-company, or legal-personal. prefix is container-relative, e.g. "INND/01_Bank-Statements/". Each item reports has_text_sidecar: whether the doc-indexer already extracted text to _TEXT/<key>.txt (what kb_get_document serves automatically for a binary source). contains does a case-insensitive substring match on the key, applied after listing. Ring-gated exactly like kb_search_privileged for the same index name: finance + legal-company require the executive ring, legal-personal requires the narrower personal-legal ring. The cto/default/external connector identity is refused; privileged dataroom keys never reach an external client.',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputShape: {
        index: z
          .enum(KB_LIST_INDEXES)
          .describe('Ring-gated finance/legal index. Caller must hold the matching trusted lane.'),
        prefix: z.string().optional().describe('Container-relative path prefix, e.g. "INND/01_Bank-Statements/".'),
        contains: z.string().optional().describe('Case-insensitive substring match on the key, applied after listing.'),
        max: z.number().int().min(1).max(2000).optional().describe('Max items to return (default 500, cap 2000).'),
        continuation: z
          .string()
          .optional()
          .describe('Offset token from a prior next_continuation, to page further into this listing.'),
      },
      outputShape: {
        index: z.string(),
        prefix: z.string().nullable(),
        count: z.number(),
        items: z.array(
          z.object({
            key: z.string(),
            size: z.number().nullable(),
            last_modified: z.string().nullable(),
            has_text_sidecar: z.boolean(),
          }),
        ),
        next_continuation: z.string().nullable(),
        truncated: z.boolean(),
        error: z.string().optional(),
      },
      handler: async (input, ctx) => {
        const index = input.index;
        const prefix = input.prefix;
        const caller = ctx.callerAgent || '';
        const empty = {
          index,
          prefix: prefix ?? null,
          count: 0,
          items: [] as ListedItem[],
          next_continuation: null as string | null,
          truncated: false,
        };

        // RING ENFORCEMENT: identical predicate to kb_search_privileged for this exact index name.
        if (!isLaneAllowed(index, caller)) {
          return {
            data: { ...empty, error: 'forbidden_ring' },
            summary: `Refused: "${index}" is ring-gated. Your identity: ${caller || '(none)'}. Privileged finance/legal dataroom keys are never served to other lanes or external clients.`,
          };
        }

        const { account, container } = storeFor(index);
        if (!account) {
          return { data: { ...empty, error: 'unconfigured' }, summary: `Store account not configured for index "${index}".` };
        }

        try {
          const [mainRows, textRows] = await Promise.all([
            listStoreBlobs(account, container, prefix),
            listStoreBlobs(account, container, `${TEXT_PREFIX}${prefix ?? ''}`),
          ]);
          const items = buildListing(mainRows, textRows, input.contains);
          const max = input.max ?? 500;
          const { page, next, truncated } = paginateItems(items, max, input.continuation);

          return {
            data: { index, prefix: prefix ?? null, count: page.length, items: page, next_continuation: next, truncated },
            summary:
              `${page.length} of ${items.length} key(s) in ${index}${prefix ? `/${prefix}` : ''}` +
              `${input.contains ? ` matching "${input.contains}"` : ''} (lane=${caller}).` +
              (truncated ? ' Pass continuation for more.' : ''),
          };
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return { data: { ...empty, error: msg }, summary: `List failed: ${msg}` };
        }
      },
    },
    callerHash,
  );
}
