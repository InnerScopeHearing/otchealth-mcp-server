import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createHash } from 'node:crypto';
import { z, type ZodRawShape } from 'zod';
import { registerTool, type CallerHashProvider, type ToolContext, type ToolResultPayload } from '../registry.js';
import { driveConfigured, downloadFile } from '../../graph/drive-client.js';
import { isDriveFolderAllowed, rolesForLane } from './ring.js';

export const graphDriveDownloadInputShape = {
  folder: z.string().min(1).describe('Folder path relative to the OneDrive root, starting with the role token, e.g. "CLO Incoming".'),
  filename: z.string().min(1).describe('The file name within the folder to download.'),
  force_base64: z.boolean().optional().describe('Return the content as base64 even if it looks textual (binary-safe download).'),
  verify_sha256_only: z
    .boolean()
    .optional()
    .describe(
      'When true, do not return the file content at all -- return only {sha256, size, contentType} computed over the exact bytes on OneDrive. Use this to verify a graph_drive_upload round trip by comparing hashes, instead of retyping a large payload through your own context.',
    ),
} satisfies ZodRawShape;

export const graphDriveDownloadOutputShape = {
  folder: z.string(),
  filename: z.string(),
  found: z.boolean(),
  contentType: z.string().nullable(),
  size: z.number().nullable(),
  text: z.string().nullable(),
  base64: z.string().nullable(),
  sha256: z.string().nullable(),
  error: z.string().optional(),
} satisfies ZodRawShape;

export type GraphDriveDownloadInput = z.infer<z.ZodObject<typeof graphDriveDownloadInputShape>>;

/**
 * `graph_drive_download` handler. Exported standalone (mirroring handleGraphDriveUpload in
 * upload.ts) so it is directly unit-testable without the full registerTool gating stack.
 *
 * INTEGRITY (P1-2, see download.test.ts): verify_sha256_only never writes anywhere -- on the
 * gateway, on disk, or anywhere else. It stays strictly read-only. An earlier version of this
 * fix persisted downloaded bytes to a path on the gateway container's own filesystem, which a
 * review correctly caught as broken: this gateway runs as 2-10 stateless Container Apps replicas
 * with no shared/mounted volume, so a "local" path written by whichever replica handled the
 * request is unreachable by the calling agent and may not even exist on the NEXT request if it
 * lands on a different replica. A hash-only response sidesteps the problem entirely: the caller
 * already has graph_drive_upload's sha256 for the same file, so comparing two short hex strings
 * proves the round trip without moving the file's bytes anywhere a second time.
 */
export async function handleGraphDriveDownload(input: GraphDriveDownloadInput, ctx: ToolContext): Promise<ToolResultPayload> {
  const caller = ctx.callerAgent || '';
  const empty = { folder: input.folder, filename: input.filename, found: false, contentType: null, size: null, text: null, base64: null, sha256: null };
  if (!isDriveFolderAllowed(caller, input.folder)) {
    return {
      data: { ...empty, error: 'forbidden_role_folder' },
      summary: `Refused: folder "${input.folder}" is not one of your role's OneDrive folders. Your identity: ${caller || '(none)'} (owns: ${rolesForLane(caller).join('/') || 'none'}).`,
    };
  }
  if (!driveConfigured()) {
    return { data: { ...empty, error: 'unconfigured' }, summary: 'Graph Drive not configured (GRAPH_* / GRAPH_DRIVE_USER unset).' };
  }
  const wantsHashOnly = input.verify_sha256_only === true;
  // When hashing we always pull the RAW bytes (force base64 internally regardless of the caller's
  // force_base64) so the hash is computed over the exact on-disk bytes -- a text decode/re-encode
  // round trip is lossy for any content that isn't valid UTF-8, which would silently corrupt the
  // very integrity check this flag exists to provide.
  const res = await downloadFile(input.folder, input.filename, input.force_base64 === true || wantsHashOnly);
  if (!res.found) {
    return { data: empty, summary: `No file "${input.filename}" in "${input.folder}".` };
  }
  if (wantsHashOnly) {
    const bytes = res.base64 != null ? Buffer.from(res.base64, 'base64') : Buffer.from(res.text ?? '', 'utf8');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    return {
      data: { folder: input.folder, filename: input.filename, found: true, contentType: res.contentType, size: res.size, text: null, base64: null, sha256 },
      summary: `"${input.folder}/${input.filename}" is ${res.size ?? bytes.length} bytes, ${res.contentType ?? 'unknown type'}, sha256=${sha256}. Compare against the sha256 graph_drive_upload returned to confirm this file round-tripped intact.`,
    };
  }
  return {
    data: { folder: input.folder, filename: input.filename, found: true, contentType: res.contentType, size: res.size, text: res.text, base64: res.base64, sha256: null },
    summary: `Downloaded "${input.folder}/${input.filename}" (${res.size ?? '?'} bytes, ${res.contentType ?? 'unknown type'}, lane=${caller}).`,
  };
}

export function registerGraphDriveDownload(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(
    server,
    {
      name: 'graph_drive_download',
      category: 'read',
      annotations: {
        title: 'Download a file from a role OneDrive folder (own-role gated)',
        description:
          'Download a file\'s content by folder + filename from the shared drive owner\'s OneDrive. Textual content is returned as text; binary (or force_base64=true) as base64. Pass verify_sha256_only=true to get back ONLY {sha256, size, contentType} (text/base64 are then null) instead of the full content -- compare that hash against the sha256 graph_drive_upload returned for the same file to prove a round trip landed intact, without ever moving the bytes through your own context. GATED by folder-name role prefix identically to graph_drive_list: a caller may only read its OWN role\'s folders. Read-only: this tool never writes anywhere, on the gateway or anywhere else.',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputShape: graphDriveDownloadInputShape,
      outputShape: graphDriveDownloadOutputShape,
      handler: handleGraphDriveDownload,
    },
    callerHash,
  );
}
