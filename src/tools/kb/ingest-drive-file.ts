/**
 * kb_ingest_drive_file — SELF-SERVICE ingest: copy one OneDrive source drop into the finance dataroom.
 *
 * WHY (CFO lane, 2026-09-05): Matt (CEO, non-technical) downloads bank statements to OneDrive under
 * `CFO Outgoing/2026/source-drops/<entity>/<account>/`. Nothing moves them from there into the
 * finance dataroom (account otchealthcfodata, container cfo-source-docs), which is where the
 * 2-hourly docintel-ocr-sweep writes `_TEXT/<path>.txt` sidecars and where kb_search_privileged /
 * kb_get_document can reach them. Until now that hop needed the CTO. It should not: the CFO lane
 * already holds BOTH halves of the operation — it can read its own OneDrive role folders
 * (graph_drive_download) and it can write into the finance dataroom
 * (mail_archive_save_attachment_to_dataroom). This tool is exactly the composition of those two
 * existing, already-authorized capabilities; it introduces no new credential, store, or ring.
 *
 * TWO GATES, BOTH REUSED VERBATIM, NEITHER WIDENED:
 *   1. RING (destination). isExecRingLane() from kb/search-privileged.ts — the SAME predicate
 *      kb_search_privileged / kb_get_document use for the finance rooms. The broad, externally
 *      reachable 'cto'/'developer' identity is excluded by construction, as it is on every other
 *      finance-dataroom surface. A write tool that could put bytes into the MNPI store from outside
 *      the ring would be a side door around that boundary, so the ring predicate is IMPORTED, never
 *      re-implemented.
 *   2. ROLE FOLDER (source). isDriveFolderAllowed() from tools/graph-drive/ring.ts — the SAME
 *      own-role folder gate graph_drive_download enforces. A cfo caller reads "CFO ..." folders and
 *      nothing else; one role never browses another's OneDrive through this tool either.
 *
 * WRITE PATH: putBlobRaw (legal/blob-store.ts), the identical helper
 * mail_archive_save_attachment_to_dataroom uses, against the identical container, with the same
 * fail-closed no-silent-clobber default (If-None-Match: * unless overwrite). Path hygiene reuses
 * kb_get_document's isSafeBlobPath so a path this tool writes is, by construction, a path
 * kb_get_document can read back.
 *
 * NEVER RETURNS OR LOGS FILE CONTENTS. The response carries only {bytes, sha256, path} — the same
 * completeness-proof shape kb_get_document returns for a whole document, minus the document. Bank
 * statements are MNPI-adjacent; there is no reason for their bytes to transit an agent's context on
 * a copy operation, and every reason for them not to.
 */
import crypto from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider, type ToolContext, type ToolResultPayload } from '../registry.js';
import { loadEnv } from '../../config/env.js';
import { putBlobRaw, fetchBlobRaw } from '../../legal/blob-store.js';
import { driveConfigured, downloadFile } from '../../graph/drive-client.js';
import { isDriveFolderAllowed, rolesForLane } from '../graph-drive/ring.js';
import { isExecRingLane } from './search-privileged.js';
import { isSafeBlobPath, TEXT_PREFIX } from './get-document.js';

/** The one physical finance-dataroom container — the same one kb_get_document reads and
 *  mail_archive_save_attachment_to_dataroom writes. See get-document.ts's header for the
 *  index-name-to-store mapping. */
const CONTAINER = 'cfo-source-docs';

/** The index name to hand back, so the caller can paste it straight into kb_get_document. Both
 *  finance index names map to this same container; this is the canonical one. */
const INDEX = 'finance-cfo-source-docs';

/**
 * Hard byte ceiling on an ingest.
 *
 * DELIBERATELY A NEW CONSTANT, because neither existing cap fits and borrowing one would misstate
 * the limit: mail/client.ts's 10MB attachment cap governs an EWS SOAP response (a different
 * transport with a different failure mode), and graph/drive-client.ts's MAX_SIMPLE_UPLOAD_BYTES
 * (250MB) is Microsoft's ceiling on the simple UPLOAD endpoint, not a statement about what this
 * gateway should hold in memory. This path buffers the whole file twice (raw bytes + the base64
 * putBlobRaw decodes), so the number that matters here is a gateway-memory number. 25 MiB clears
 * every scanned bank statement by a wide margin while keeping a mis-aimed ingest of a video or a
 * database dump from pressuring a replica.
 */
export const MAX_INGEST_BYTES = 25 * 1024 * 1024;

/** Why a destination path was refused, or null when it is acceptable. Pure + exported so the
 *  validation is directly unit-testable without an MCP harness (same pattern as
 *  get-document.ts's isSafeBlobPath / financeStoreConfigError). */
export function destPathError(destPath: string): string | null {
  if (!destPath) return 'dest_path is required.';
  if (destPath.startsWith('/')) return 'dest_path must be container-relative — it must not start with "/".';
  if (destPath.includes('..')) return 'dest_path must not contain ".." (no path traversal).';
  if (destPath.startsWith(TEXT_PREFIX)) {
    return (
      `dest_path must not start with "${TEXT_PREFIX}" — that prefix is owned by the docintel-ocr-sweep, ` +
      'which writes the extracted-text sidecar for each source blob there. Writing a source file into ' +
      'it would collide with (or masquerade as) machine-generated text. Give the source document its ' +
      'own path; the sidecar appears under _TEXT/ automatically.'
    );
  }
  if (!isSafeBlobPath(destPath)) return 'dest_path must be a container-relative blob path (no absolute/URL form, no backslashes, max 1024 chars).';
  return null;
}

export const kbIngestDriveFileInputShape = {
  source_folder: z
    .string()
    .min(1)
    .describe('OneDrive folder path relative to the drive root, starting with your role token, e.g. "CFO Outgoing/2026/source-drops/INND/WF-9145".'),
  filename: z.string().min(1).describe('The file name within that folder, e.g. "2023-05-statement.pdf".'),
  dest_path: z
    .string()
    .min(1)
    .describe('Container-relative destination in the finance dataroom, e.g. "INND/2026-source-drops/WF-9145/2023-05-statement.pdf". No "..", no leading "/", must not start with "_TEXT/".'),
  overwrite: z.boolean().optional().describe('Allow replacing an existing blob at dest_path. Default false (refuses to silently clobber).'),
};

export const kbIngestDriveFileOutputShape = {
  written: z.boolean(),
  index: z.string(),
  path: z.string(),
  container: z.string(),
  bytes: z.number().nullable(),
  sha256: z.string().nullable(),
  content_type: z.string().nullable(),
  dry_run: z.boolean(),
  note: z.string().optional(),
  error: z.string().optional(),
};

export type KbIngestDriveFileInput = z.infer<z.ZodObject<typeof kbIngestDriveFileInputShape>>;

/** The post-write note. Stated once, returned verbatim, so the CFO lane is never left wondering
 *  why a freshly ingested statement is not yet searchable. */
export const OCR_NOTE =
  'OCR sidecar arrives on the next docintel-ocr-sweep run (about every 2 hours); then searchable via ' +
  'kb_search_privileged and readable via kb_get_document with this path';

/**
 * Injectable seams for the two stores and the env. Real implementations are the defaults; tests
 * substitute stubs so the ring/path/overwrite/dry-run decisions are exercised without Graph, Azure,
 * or a live MCP server (mirroring how get-document.test.ts tests its pure helpers directly).
 */
export interface IngestDeps {
  driveConfigured: () => boolean;
  downloadFile: typeof downloadFile;
  fetchBlobRaw: typeof fetchBlobRaw;
  putBlobRaw: typeof putBlobRaw;
  env: () => { AZURE_CFO_STORAGE_ACCOUNT: string; AZURE_CFO_STORAGE_KEY: string };
}

const REAL_DEPS: IngestDeps = { driveConfigured, downloadFile, fetchBlobRaw, putBlobRaw, env: loadEnv };

export async function handleKbIngestDriveFile(
  input: KbIngestDriveFileInput,
  ctx: Pick<ToolContext, 'callerAgent' | 'dryRun'>,
  deps: IngestDeps = REAL_DEPS,
): Promise<ToolResultPayload> {
  const caller = ctx.callerAgent || '';
  const destPath = input.dest_path.trim();
  const empty = {
    written: false,
    index: INDEX,
    path: destPath,
    container: CONTAINER,
    bytes: null,
    sha256: null,
    content_type: null,
    dry_run: Boolean(ctx.dryRun),
  };

  // GATE 1 — destination ring. Identical boundary to kb_search_privileged / kb_get_document.
  if (!isExecRingLane(caller)) {
    return {
      data: { ...empty, error: 'forbidden_ring' },
      summary:
        `Refused: the finance dataroom is ring-gated (MNPI). Your identity: ${caller || '(none)'}. ` +
        'Writing into it is limited to the executive ring, exactly as reading it is — the broad cto/developer/external ' +
        'connector identity is excluded by construction.',
    };
  }

  // GATE 2 — source folder must be one of the caller's OWN role folders, same rule graph_drive_download applies.
  if (!isDriveFolderAllowed(caller, input.source_folder)) {
    return {
      data: { ...empty, error: 'forbidden_role_folder' },
      summary: `Refused: folder "${input.source_folder}" is not one of your role's OneDrive folders. Your identity: ${caller} (owns: ${rolesForLane(caller).join('/') || 'none'}).`,
    };
  }

  const pathError = destPathError(destPath);
  if (pathError) {
    return { data: { ...empty, error: 'invalid_path' }, summary: `Refused: ${pathError}` };
  }

  if (!deps.driveConfigured()) {
    return { data: { ...empty, error: 'unconfigured' }, summary: 'Graph Drive not configured (GRAPH_* / GRAPH_DRIVE_USER unset) — cannot read the source drop.' };
  }
  const env = deps.env();
  if (!env.AZURE_CFO_STORAGE_ACCOUNT || !env.AZURE_CFO_STORAGE_KEY) {
    // Deliberately requires the KEY, unlike kb_get_document's financeStoreConfigError: this is a
    // WRITE, and putBlobRaw is Azure-SharedKey-only (the S3 mirror is read-only by design — see
    // s3-blob-store.ts's header). Same requirement, for the same reason, as
    // mail_archive_save_attachment_to_dataroom.
    return {
      data: { ...empty, error: 'unconfigured' },
      summary: 'The finance dataroom is not configured for writes (AZURE_CFO_STORAGE_ACCOUNT / AZURE_CFO_STORAGE_KEY unset).',
    };
  }

  // OVERWRITE GUARD, checked BEFORE the download so a refusal costs nothing. putBlobRaw's
  // If-None-Match: * remains the race-safe backstop for a blob created between this check and the
  // PUT; this check exists to give the caller a clear, actionable refusal instead of a raw 409.
  if (input.overwrite !== true) {
    const existing = await deps.fetchBlobRaw(env.AZURE_CFO_STORAGE_ACCOUNT, env.AZURE_CFO_STORAGE_KEY, CONTAINER, destPath);
    if (existing.found) {
      return {
        data: { ...empty, error: 'exists' },
        summary: `Refused: a blob already exists at ${CONTAINER}/${destPath}. Pass overwrite:true to intentionally replace it, or choose a different dest_path.`,
      };
    }
  }

  // force_base64=true: binary-safe by construction. A statement PDF must never be decoded as UTF-8
  // on the way through (the mojibake class of defect get-document.ts's looksBinary() documents).
  const src = await deps.downloadFile(input.source_folder, input.filename, true);
  if (!src.found) {
    return { data: empty, summary: `No file "${input.filename}" in "${input.source_folder}".` };
  }
  const base64 = src.base64 ?? Buffer.from(src.text ?? '', 'utf8').toString('base64');
  const buf = Buffer.from(base64, 'base64');
  const bytes = buf.length;
  if (bytes > MAX_INGEST_BYTES) {
    return {
      data: { ...empty, error: 'too_large' },
      summary: `Refused: "${input.source_folder}/${input.filename}" is ${bytes} bytes, over the ${MAX_INGEST_BYTES}-byte ingest cap. Split it, or ask the CTO to move it directly.`,
    };
  }
  const contentType = src.contentType || 'application/octet-stream';
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex');

  if (ctx.dryRun) {
    return {
      data: { ...empty, bytes, sha256, content_type: contentType, note: OCR_NOTE },
      summary:
        `DRY RUN (nothing written): would copy "${input.source_folder}/${input.filename}" (${bytes} bytes, ${contentType}, ` +
        `sha256=${sha256.slice(0, 12)}…) to ${CONTAINER}/${destPath}${input.overwrite === true ? ' (overwriting)' : ''}. ` +
        'Re-call with dry_run:false to actually copy.',
    };
  }

  const put = await deps.putBlobRaw(
    env.AZURE_CFO_STORAGE_ACCOUNT,
    env.AZURE_CFO_STORAGE_KEY,
    CONTAINER,
    destPath,
    { base64, contentType },
    input.overwrite ?? false,
  );
  return {
    data: {
      written: true,
      index: INDEX,
      path: put.path,
      container: put.container,
      bytes: put.bytes,
      sha256,
      content_type: put.contentType,
      dry_run: false,
      note: OCR_NOTE,
    },
    summary:
      `Copied "${input.source_folder}/${input.filename}" into the finance dataroom at ${put.container}/${put.path} ` +
      `(${put.bytes} bytes, ${put.contentType}, sha256=${sha256.slice(0, 12)}…, lane=${caller}). ${OCR_NOTE}.`,
  };
}

export function registerKbIngestDriveFile(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(
    server,
    {
      name: 'kb_ingest_drive_file',
      category: 'write_simple',
      annotations: {
        title: 'Copy a OneDrive source drop into the finance dataroom (executive ring only)',
        description:
          'Copy ONE file from your own role\'s OneDrive folder into the finance dataroom (account otchealthcfodata, container cfo-source-docs) — the self-service ingest path for a source drop Matt saved to OneDrive (e.g. "CFO Outgoing/2026/source-drops/INND/WF-9145/2023-05-statement.pdf"). ' +
          'source_folder + filename name the OneDrive file (own-role gated exactly like graph_drive_download); dest_path is the container-relative destination, e.g. "INND/2026-source-drops/WF-9145/2023-05-statement.pdf" (no "..", no leading "/", must not start with "_TEXT/" — that prefix belongs to the OCR sweep). ' +
          'Ring-gated to the executive ring exactly like kb_search_privileged / kb_get_document. Refuses to silently replace an existing blob unless overwrite:true. 25 MiB cap. ' +
          'dry_run defaults TRUE like every write tool in this gateway — omit it and the call only PREVIEWS the copy; pass dry_run:false to actually write. ' +
          'Never returns or logs file contents: the response carries only {path, bytes, sha256}. After the write the file is readable by exact path via kb_get_document immediately; its searchable text sidecar appears on the next docintel-ocr-sweep run (about every 2 hours).',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      inputShape: kbIngestDriveFileInputShape,
      outputShape: kbIngestDriveFileOutputShape,
      handler: (input, ctx) => handleKbIngestDriveFile(input, ctx),
    },
    callerHash,
  );
}
