import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { driveConfigured, listFolder } from '../../graph/drive-client.js';
import { isDriveFolderAllowed, rolesForLane } from './ring.js';

export function registerGraphDriveList(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(
    server,
    {
      name: 'graph_drive_list',
      category: 'read',
      annotations: {
        title: 'List files in a role OneDrive folder (own-role gated)',
        description:
          'List files in a OneDrive folder path (e.g. "CLO Outgoing", "CLO Incoming/subfolder") on the shared drive owner\'s OneDrive. Parameterized by folder name so any role\'s three-folder exchange (Outgoing/Incoming/Processed) can be listed. GATED by folder-name role prefix: a caller may only list its OWN role\'s folders (a clo caller -> CLO folders, a cto caller -> CTO folders); one role cannot browse another role\'s folders. Read-only.',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputShape: {
        folder: z.string().min(1).describe('Folder path relative to the OneDrive root, starting with the role token, e.g. "CLO Outgoing" or "CTO Processed/2026".'),
      },
      outputShape: {
        folder: z.string(),
        files: z.array(
          z.object({
            name: z.string(),
            id: z.string(),
            size: z.number().nullable(),
            lastModified: z.string().nullable(),
            isFolder: z.boolean(),
            contentType: z.string().nullable(),
          }),
        ),
        count: z.number(),
        error: z.string().optional(),
      },
      handler: async (input, ctx) => {
        const caller = ctx.callerAgent || '';
        if (!isDriveFolderAllowed(caller, input.folder)) {
          return {
            data: { folder: input.folder, files: [], count: 0, error: 'forbidden_role_folder' },
            summary: `Refused: folder "${input.folder}" is not one of your role's OneDrive folders. Your identity: ${caller || '(none)'} (owns: ${rolesForLane(caller).join('/') || 'none'}). One role cannot browse another role's OneDrive folders.`,
          };
        }
        if (!driveConfigured()) {
          return { data: { folder: input.folder, files: [], count: 0, error: 'unconfigured' }, summary: 'Graph Drive not configured (GRAPH_* / GRAPH_DRIVE_USER unset).' };
        }
        const files = await listFolder(input.folder);
        return {
          data: { folder: input.folder, files, count: files.length },
          summary: `${files.length} item(s) in "${input.folder}" (lane=${caller}).`,
        };
      },
    },
    callerHash,
  );
}
