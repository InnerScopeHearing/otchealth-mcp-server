import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { miroFetch } from '../../miro/client.js';

const COLORS = ['gray','light_yellow','yellow','orange','light_green','green','dark_green','cyan','light_pink','pink','violet','red','light_blue','blue','dark_blue','black'] as const;

export function registerMiroCreateStickyNote(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(
    server,
    {
      name: 'miro_create_sticky_note',
      category: 'write_simple',
      annotations: {
        title: 'Miro: create sticky note',
        description: 'Add a sticky note to a Miro board at an (x,y) position with optional fill color — the building block for laying out a diagram/flow. Honors dry_run (plan-only by default).',
        readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true,
      },
      inputShape: {
        board_id: z.string().describe('Target board id.'),
        content: z.string().describe('Text content (plain or simple HTML).'),
        x: z.number().optional().describe('X position (default 0).'),
        y: z.number().optional().describe('Y position (default 0).'),
        fillColor: z.enum(COLORS).optional().describe('Sticky fill color.'),
      },
      outputShape: { id: z.string().optional(), planned: z.boolean().optional() },
      handler: async (input, ctx) => {
        if (ctx.dryRun) return { data: { planned: true }, summary: `DRY RUN: would add a sticky note to board ${input.board_id}. Pass dry_run=false to execute.` };
        const body: Record<string, unknown> = { data: { content: input.content }, position: { x: input.x ?? 0, y: input.y ?? 0 } };
        if (input.fillColor) (body as any).style = { fillColor: input.fillColor };
        const r = await miroFetch<{ id: string }>('POST', `/boards/${encodeURIComponent(input.board_id)}/sticky_notes`, body, { correlationId: ctx.correlationId });
        return { data: { id: r.id }, summary: `Added sticky note (${r.id}) to board ${input.board_id}.`, audit: { after: { id: r.id } } };
      },
    },
    callerHash,
  );
}
