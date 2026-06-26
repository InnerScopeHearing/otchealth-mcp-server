import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { miroFetch } from '../../miro/client.js';

export function registerMiroCreateBoard(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(
    server,
    {
      name: 'miro_create_board',
      category: 'write_simple',
      annotations: {
        title: 'Miro: create board',
        description: 'Create a new Miro board (name + optional description). Returns the board id and viewLink. Honors dry_run (plan-only by default).',
        readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true,
      },
      inputShape: { name: z.string().describe('Board name.'), description: z.string().optional() },
      outputShape: { id: z.string().optional(), viewLink: z.string().optional(), planned: z.boolean().optional() },
      handler: async (input, ctx) => {
        if (ctx.dryRun) return { data: { planned: true }, summary: `DRY RUN: would create Miro board "${input.name}". Pass dry_run=false to execute.` };
        const r = await miroFetch<{ id: string; viewLink?: string }>('POST', `/boards`, { name: input.name, description: input.description ?? '' }, { correlationId: ctx.correlationId });
        return { data: { id: r.id, viewLink: r.viewLink }, summary: `Created Miro board "${input.name}" (${r.viewLink ?? r.id}).`, audit: { after: { id: r.id } } };
      },
    },
    callerHash,
  );
}
