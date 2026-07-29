import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createHash } from 'node:crypto';
import { z, type ZodRawShape } from 'zod';
import { registerTool, type CallerHashProvider, type ToolContext, type ToolResultPayload } from '../registry.js';
import { driveConfigured, driveItemExists, uploadFile, MAX_SIMPLE_UPLOAD_BYTES } from '../../graph/drive-client.js';
import { isDriveFolderAllowed, rolesForLane } from './ring.js';

export const graphDriveUploadInputShape = {
  folder: z.string().min(1).describe('Destination folder path relative to the OneDrive root, starting with the role token, e.g. "CLO Incoming".'),
  filename: z.string().min(1).describe('The file name to create in the folder.'),
  text: z.string().optional().describe('Text content to upload (mutually exclusive with base64).'),
  base64: z.string().optional().describe('Base64-encoded binary content to upload (mutually exclusive with text).'),
  content_type: z.string().optional().describe('Content-Type to store (default application/octet-stream).'),
  overwrite: z.boolean().optional().describe('Set true to intentionally replace an existing file. Default false = REFUSE if the file already exists (never silently overwrite).'),
} satisfies ZodRawShape;

export const graphDriveUploadOutputShape = {
  executed: z.boolean(),
  dry_run: z.boolean(),
  folder: z.string(),
  filename: z.string(),
  bytes: z.number().nullable(),
  overwrote: z.boolean(),
  sha256: z.string().nullable(),
  error: z.string().optional(),
} satisfies ZodRawShape;

export type GraphDriveUploadInput = z.infer<z.ZodObject<typeof graphDriveUploadInputShape>>;

/**
 * `graph_drive_upload` handler. Exported standalone (rather than inline in the register call) so
 * it is directly unit-testable without standing up the full registerTool gating stack, mirroring
 * the pattern in tools/kb/openai-fetch.ts.
 *
 * INTEGRITY (the P1 fix, see upload.test.ts): every successful upload returns a `sha256` computed
 * over the EXACT `content` Buffer sent to Graph, and the tool NEVER reports `executed: true` unless
 * Graph's own reported byte count matches that buffer's length exactly. A short/incomplete write,
 * including the case where Graph's response omits a size entirely, comes back as an explicit
 * `error: 'incomplete_upload'` with the expected and actual byte counts, never a silent success.
 */
export async function handleGraphDriveUpload(input: GraphDriveUploadInput, ctx: ToolContext): Promise<ToolResultPayload> {
  const caller = ctx.callerAgent || '';
  const base = {
    executed: false,
    dry_run: ctx.dryRun,
    folder: input.folder,
    filename: input.filename,
    bytes: null as number | null,
    overwrote: false,
    sha256: null as string | null,
  };

  if (!isDriveFolderAllowed(caller, input.folder)) {
    return {
      data: { ...base, error: 'forbidden_role_folder' },
      summary: `Refused: folder "${input.folder}" is not one of your role's OneDrive folders. Your identity: ${caller || '(none)'} (owns: ${rolesForLane(caller).join('/') || 'none'}).`,
    };
  }
  if (input.text != null && input.base64 != null) {
    return { data: { ...base, error: 'invalid_input' }, summary: 'Provide exactly one of text or base64, not both.' };
  }
  if (input.text == null && input.base64 == null) {
    return { data: { ...base, error: 'invalid_input' }, summary: 'Provide content via text or base64.' };
  }
  if (!driveConfigured()) {
    return { data: { ...base, error: 'unconfigured' }, summary: 'Graph Drive not configured (GRAPH_* / GRAPH_DRIVE_USER unset).' };
  }

  // Compute the exact bytes to be written, and their integrity fingerprint, up front. This is
  // pure/local (no network yet), so it runs identically whether the call ends up a dry run, a
  // size refusal, or a real upload, the hash always describes the content that WOULD be (or
  // was) written, never something reconstructed after the fact from a lossy round trip.
  const content = input.base64 != null ? Buffer.from(input.base64, 'base64') : Buffer.from(input.text ?? '', 'utf8');
  const sha256 = createHash('sha256').update(content).digest('hex');

  // FAIL LOUD rather than silently mis-upload: Microsoft Graph's simple content-PUT endpoint only
  // supports files up to MAX_SIMPLE_UPLOAD_BYTES (4 MiB); anything larger needs a resumable
  // upload session, which this tool does not implement (see drive-client.ts's doc comment). This
  // is the concrete, documented ceiling behind "large payloads silently truncated" reports,
  // refusing here turns that into a loud, explicit error instead of an unverified write.
  if (content.length > MAX_SIMPLE_UPLOAD_BYTES) {
    return {
      data: { ...base, sha256, error: 'file_too_large_for_simple_upload' },
      summary: `Refused: "${input.folder}/${input.filename}" is ${content.length} bytes, over the ${MAX_SIMPLE_UPLOAD_BYTES}-byte (4 MiB) limit Microsoft Graph's simple upload endpoint supports. A resumable upload session is required above this size and is not implemented by this tool yet (sha256 of the content you provided: ${sha256}).`,
    };
  }

  const overwrite = input.overwrite === true;

  // FAIL-CLOSED: refuse when the file already exists and overwrite was not explicitly requested.
  const exists = await driveItemExists(input.folder, input.filename);
  if (exists && !overwrite) {
    return {
      data: { ...base, sha256, error: 'exists_no_overwrite' },
      summary: `Refused: a file already exists at "${input.folder}/${input.filename}". Pass overwrite=true to intentionally replace it.`,
    };
  }

  if (ctx.dryRun) {
    return {
      data: { ...base, dry_run: true, overwrote: exists && overwrite, sha256 },
      audit: { before: exists ? { existed: true } : null, after: { folder: input.folder, filename: input.filename, overwrite } },
      summary: `DRY RUN: would ${exists ? 'OVERWRITE' : 'upload'} "${input.folder}/${input.filename}" (${content.length} bytes, sha256=${sha256}). Pass dry_run=false to apply.`,
    };
  }

  const up = await uploadFile(input.folder, input.filename, content, input.content_type);

  // THE P1 FIX: never report success on a short/incomplete write. `up.size` is `null` (not
  // silently defaulted to content.length by drive-client.ts) whenever Graph's own response did
  // not confirm a numeric size, so this comparison is a real check, not a tautology.
  if (up.size == null || up.size !== content.length) {
    return {
      data: { ...base, bytes: up.size, sha256, error: 'incomplete_upload' },
      audit: {
        before: exists ? { existed: true } : null,
        after: { folder: input.folder, filename: input.filename, expected_bytes: content.length, actual_bytes: up.size },
      },
      summary: `UPLOAD INCOMPLETE for "${input.folder}/${input.filename}": expected ${content.length} bytes, Graph reported ${up.size ?? 'unknown'}. Refusing to report success on a short/incomplete write. The file at this path should be treated as corrupt/unverified until re-uploaded and re-verified. sha256 of the content you sent: ${sha256}.`,
    };
  }

  return {
    data: { ...base, executed: true, bytes: up.size, overwrote: exists && overwrite, sha256 },
    audit: { before: exists ? { existed: true } : null, after: { folder: input.folder, filename: input.filename, bytes: up.size, sha256 } },
    summary: `${exists ? 'Overwrote' : 'Uploaded'} "${input.folder}/${input.filename}" (${up.size} bytes, sha256=${sha256}, lane=${caller}).`,
  };
}

export function registerGraphDriveUpload(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(
    server,
    {
      name: 'graph_drive_upload',
      category: 'write_simple',
      annotations: {
        title: 'Upload a file to a role OneDrive folder (own-role gated, no silent overwrite, hash-verified)',
        description:
          'Upload a file to a OneDrive folder path (e.g. "CLO Incoming") on the shared drive owner\'s OneDrive. Provide text OR base64 content. Returns a sha256 computed over the exact bytes sent, and NEVER reports success (executed:true) unless Graph confirms the exact same byte count back, a short/incomplete write comes back as error:"incomplete_upload" instead. Files over 4 MiB are refused (error:"file_too_large_for_simple_upload"; Graph\'s simple-upload endpoint has no larger capacity and this tool does not implement a resumable upload session). FAIL-CLOSED SAFETY DEFAULT: if a file already exists at that folder+filename, the upload is REFUSED; pass overwrite=true to intentionally replace it. GATED by folder-name role prefix identically to graph_drive_list: a caller may only write to its OWN role\'s folders. Defaults to dry_run.',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      inputShape: graphDriveUploadInputShape,
      outputShape: graphDriveUploadOutputShape,
      handler: handleGraphDriveUpload,
    },
    callerHash,
  );
}
