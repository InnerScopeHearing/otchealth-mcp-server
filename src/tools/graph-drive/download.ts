import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { driveConfigured, downloadFile } from '../../graph/drive-client.js';
import { isDriveFolderAllowed, rolesForLane } from './ring.js';
import { writeLocalFile } from '../local-file-write.js';

export function registerGraphDriveDownload(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(
    server,
    {
      name: 'graph_drive_download',
      category: 'read',
      annotations: {
        title: 'Download a file from a role OneDrive folder (own-role gated)',
        description:
          'Download a file\'s content by folder + filename from the shared drive owner\'s OneDrive. Textual content is returned as text; binary (or force_base64=true) as base64. Pass write_to_path to ALSO (or instead) persist the exact bytes to a local file, confined to a safe write root, and get back {path, bytes, sha256} — a proof you can diff against the sha256 graph_drive_upload returned for the same file, instead of round-tripping a large base64 payload through your own context (which risks silent corruption on retyping). GATED by folder-name role prefix identically to graph_drive_list: a caller may only read its OWN role\'s folders. Read-only (the local write never touches OneDrive or any tracked system of record).',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputShape: {
        folder: z.string().min(1).describe('Folder path relative to the OneDrive root, starting with the role token, e.g. "CLO Incoming".'),
        filename: z.string().min(1).describe('The file name within the folder to download.'),
        force_base64: z.boolean().optional().describe('Return the content as base64 even if it looks textual (binary-safe download).'),
        write_to_path: z
          .string()
          .optional()
          .describe(
            'When set, write the downloaded content byte-for-byte to this local path instead of returning it inline (text/base64 in the response are then null). The path is resolved against a fixed, confined write root and MUST NOT contain "..". Returns {path, bytes, sha256} so you can verify round-trip integrity against a hash returned by graph_drive_upload, rather than reconstructing the payload by hand.',
          ),
      },
      outputShape: {
        folder: z.string(),
        filename: z.string(),
        found: z.boolean(),
        contentType: z.string().nullable(),
        size: z.number().nullable(),
        text: z.string().nullable(),
        base64: z.string().nullable(),
        written_path: z.string().nullable(),
        written_bytes: z.number().nullable(),
        sha256: z.string().nullable(),
        error: z.string().optional(),
      },
      handler: async (input, ctx) => {
        const caller = ctx.callerAgent || '';
        const empty = { folder: input.folder, filename: input.filename, found: false, contentType: null, size: null, text: null, base64: null, written_path: null, written_bytes: null, sha256: null };
        if (!isDriveFolderAllowed(caller, input.folder)) {
          return {
            data: { ...empty, error: 'forbidden_role_folder' },
            summary: `Refused: folder "${input.folder}" is not one of your role's OneDrive folders. Your identity: ${caller || '(none)'} (owns: ${rolesForLane(caller).join('/') || 'none'}).`,
          };
        }
        if (!driveConfigured()) {
          return { data: { ...empty, error: 'unconfigured' }, summary: 'Graph Drive not configured (GRAPH_* / GRAPH_DRIVE_USER unset).' };
        }
        // When writing to disk we always pull the RAW bytes (force base64 internally regardless of
        // the caller's force_base64) so the written file is byte-exact — a text decode/re-encode
        // round trip is lossy for any content that isn't valid UTF-8, which would silently corrupt
        // the very integrity check this flag exists to provide.
        const wantsFile = typeof input.write_to_path === 'string' && input.write_to_path.length > 0;
        const res = await downloadFile(input.folder, input.filename, input.force_base64 === true || wantsFile);
        if (!res.found) {
          return { data: empty, summary: `No file "${input.filename}" in "${input.folder}".` };
        }
        if (wantsFile) {
          const bytes = res.base64 != null ? Buffer.from(res.base64, 'base64') : Buffer.from(res.text ?? '', 'utf8');
          try {
            const written = await writeLocalFile(input.write_to_path as string, bytes);
            return {
              data: { folder: input.folder, filename: input.filename, found: true, contentType: res.contentType, size: res.size, text: null, base64: null, written_path: written.path, written_bytes: written.bytes, sha256: written.sha256 },
              summary: `Downloaded "${input.folder}/${input.filename}" (${written.bytes} bytes, ${res.contentType ?? 'unknown type'}) and wrote it to "${written.path}" (sha256=${written.sha256}, lane=${caller}).`,
            };
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            return {
              data: { ...empty, found: true, error: msg.includes('bad_path') || msg.includes('outside_write_root') ? 'bad_path' : 'write_failed' },
              summary: `Downloaded "${input.folder}/${input.filename}" but failed to write it to "${input.write_to_path}": ${msg}`,
            };
          }
        }
        return {
          data: { folder: input.folder, filename: input.filename, found: true, contentType: res.contentType, size: res.size, text: res.text, base64: res.base64, written_path: null, written_bytes: null, sha256: null },
          summary: `Downloaded "${input.folder}/${input.filename}" (${res.size ?? '?'} bytes, ${res.contentType ?? 'unknown type'}, lane=${caller}).`,
        };
      },
    },
    callerHash,
  );
}
