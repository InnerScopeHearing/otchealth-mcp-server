import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { driveConfigured, driveItemExists, uploadFile } from '../../graph/drive-client.js';
import { isDriveFolderAllowed, rolesForLane } from './ring.js';

export function registerGraphDriveUpload(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(
    server,
    {
      name: 'graph_drive_upload',
      category: 'write_simple',
      annotations: {
        title: 'Upload a file to a role OneDrive folder (own-role gated, no silent overwrite)',
        description:
          'Upload a file to a OneDrive folder path (e.g. "CLO Incoming") on the shared drive owner\'s OneDrive. Provide text OR base64 content. FAIL-CLOSED SAFETY DEFAULT: if a file already exists at that folder+filename, the upload is REFUSED; pass overwrite=true to intentionally replace it. GATED by folder-name role prefix identically to graph_drive_list: a caller may only write to its OWN role\'s folders. Returns a sha256 of the exact bytes uploaded so a later graph_drive_download(write_to_path=...) of the same file can be verified byte-for-byte instead of eyeballed. Defaults to dry_run.',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      inputShape: {
        folder: z.string().min(1).describe('Destination folder path relative to the OneDrive root, starting with the role token, e.g. "CLO Incoming".'),
        filename: z.string().min(1).describe('The file name to create in the folder.'),
        text: z.string().optional().describe('Text content to upload (mutually exclusive with base64).'),
        base64: z.string().optional().describe('Base64-encoded binary content to upload (mutually exclusive with text).'),
        content_type: z.string().optional().describe('Content-Type to store (default application/octet-stream).'),
        overwrite: z.boolean().optional().describe('Set true to intentionally replace an existing file. Default false = REFUSE if the file already exists (never silently overwrite).'),
      },
      outputShape: {
        executed: z.boolean(),
        dry_run: z.boolean(),
        folder: z.string(),
        filename: z.string(),
        bytes: z.number().nullable(),
        sha256: z.string().nullable(),
        overwrote: z.boolean(),
        error: z.string().optional(),
      },
      handler: async (input, ctx) => {
        const caller = ctx.callerAgent || '';
        if (!isDriveFolderAllowed(caller, input.folder)) {
          return {
            data: { executed: false, dry_run: ctx.dryRun, folder: input.folder, filename: input.filename, bytes: null, sha256: null, overwrote: false, error: 'forbidden_role_folder' },
            summary: `Refused: folder "${input.folder}" is not one of your role's OneDrive folders. Your identity: ${caller || '(none)'} (owns: ${rolesForLane(caller).join('/') || 'none'}).`,
          };
        }
        if (input.text != null && input.base64 != null) {
          return { data: { executed: false, dry_run: ctx.dryRun, folder: input.folder, filename: input.filename, bytes: null, sha256: null, overwrote: false, error: 'invalid_input' }, summary: 'Provide exactly one of text or base64, not both.' };
        }
        if (input.text == null && input.base64 == null) {
          return { data: { executed: false, dry_run: ctx.dryRun, folder: input.folder, filename: input.filename, bytes: null, sha256: null, overwrote: false, error: 'invalid_input' }, summary: 'Provide content via text or base64.' };
        }
        if (!driveConfigured()) {
          return { data: { executed: false, dry_run: ctx.dryRun, folder: input.folder, filename: input.filename, bytes: null, sha256: null, overwrote: false, error: 'unconfigured' }, summary: 'Graph Drive not configured (GRAPH_* / GRAPH_DRIVE_USER unset).' };
        }
        const overwrite = input.overwrite === true;

        // FAIL-CLOSED: refuse when the file already exists and overwrite was not explicitly requested.
        const exists = await driveItemExists(input.folder, input.filename);
        if (exists && !overwrite) {
          return {
            data: { executed: false, dry_run: ctx.dryRun, folder: input.folder, filename: input.filename, bytes: null, sha256: null, overwrote: false, error: 'exists_no_overwrite' },
            summary: `Refused: a file already exists at "${input.folder}/${input.filename}". Pass overwrite=true to intentionally replace it.`,
          };
        }

        const content = input.base64 != null ? Buffer.from(input.base64, 'base64') : Buffer.from(input.text ?? '', 'utf8');
        const sha256 = createHash('sha256').update(content).digest('hex');

        if (ctx.dryRun) {
          return {
            data: { executed: false, dry_run: true, folder: input.folder, filename: input.filename, bytes: content.length, sha256, overwrote: exists && overwrite },
            audit: { before: exists ? { existed: true } : null, after: { folder: input.folder, filename: input.filename, overwrite } },
            summary: `DRY RUN: would ${exists ? 'OVERWRITE' : 'upload'} "${input.folder}/${input.filename}" (sha256=${sha256}). Pass dry_run=false to apply.`,
          };
        }

        const up = await uploadFile(input.folder, input.filename, content, input.content_type);
        return {
          data: { executed: true, dry_run: false, folder: input.folder, filename: input.filename, bytes: up.size, sha256, overwrote: exists && overwrite },
          audit: { before: exists ? { existed: true } : null, after: { folder: input.folder, filename: input.filename, bytes: up.size, sha256 } },
          summary: `${exists ? 'Overwrote' : 'Uploaded'} "${input.folder}/${input.filename}" (${up.size ?? content.length} bytes, sha256=${sha256}, lane=${caller}).`,
        };
      },
    },
    callerHash,
  );
}
