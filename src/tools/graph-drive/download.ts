import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { driveConfigured, downloadFile } from '../../graph/drive-client.js';
import { isDriveFolderAllowed, rolesForLane } from './ring.js';

export function registerGraphDriveDownload(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(
    server,
    {
      name: 'graph_drive_download',
      category: 'read',
      annotations: {
        title: 'Download a file from a role OneDrive folder (own-role gated)',
        description:
          'Download a file\'s content by folder + filename from the shared drive owner\'s OneDrive. Textual content is returned as text; binary (or force_base64=true) as base64. GATED by folder-name role prefix identically to graph_drive_list: a caller may only read its OWN role\'s folders. Read-only.',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputShape: {
        folder: z.string().min(1).describe('Folder path relative to the OneDrive root, starting with the role token, e.g. "CLO Incoming".'),
        filename: z.string().min(1).describe('The file name within the folder to download.'),
        force_base64: z.boolean().optional().describe('Return the content as base64 even if it looks textual (binary-safe download).'),
      },
      outputShape: {
        folder: z.string(),
        filename: z.string(),
        found: z.boolean(),
        contentType: z.string().nullable(),
        size: z.number().nullable(),
        text: z.string().nullable(),
        base64: z.string().nullable(),
        error: z.string().optional(),
      },
      handler: async (input, ctx) => {
        const caller = ctx.callerAgent || '';
        if (!isDriveFolderAllowed(caller, input.folder)) {
          return {
            data: { folder: input.folder, filename: input.filename, found: false, contentType: null, size: null, text: null, base64: null, error: 'forbidden_role_folder' },
            summary: `Refused: folder "${input.folder}" is not one of your role's OneDrive folders. Your identity: ${caller || '(none)'} (owns: ${rolesForLane(caller).join('/') || 'none'}).`,
          };
        }
        if (!driveConfigured()) {
          return { data: { folder: input.folder, filename: input.filename, found: false, contentType: null, size: null, text: null, base64: null, error: 'unconfigured' }, summary: 'Graph Drive not configured (GRAPH_* / GRAPH_DRIVE_USER unset).' };
        }
        const res = await downloadFile(input.folder, input.filename, input.force_base64 === true);
        if (!res.found) {
          return { data: { folder: input.folder, filename: input.filename, found: false, contentType: null, size: null, text: null, base64: null }, summary: `No file "${input.filename}" in "${input.folder}".` };
        }
        return {
          data: { folder: input.folder, filename: input.filename, found: true, contentType: res.contentType, size: res.size, text: res.text, base64: res.base64 },
          summary: `Downloaded "${input.folder}/${input.filename}" (${res.size ?? '?'} bytes, ${res.contentType ?? 'unknown type'}, lane=${caller}).`,
        };
      },
    },
    callerHash,
  );
}
