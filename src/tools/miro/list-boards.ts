import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { miroFetch, miroConfigured } from '../../miro/client.js';

export function registerMiroListBoards(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(
    server,
    {
      name: 'miro_list_boards',
      category: 'read',
      annotations: {
        title: 'Miro: list boards',
        description: 'List Miro boards in the connected team. Returns id, name, and viewLink. Read-only.',
        readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
      },
      inputShape: { limit: z.number().int().min(1).max(50).optional(), query: z.string().optional().describe('Filter by name.') },
      outputShape: { boards: z.array(z.unknown()), count: z.number(), error: z.string().optional() },
      handler: async (input, ctx) => {
        if (!miroConfigured()) return { data: { boards: [], count: 0, error: 'miro_not_configured' }, summary: 'Miro not configured (MIRO_TOKEN unset).' };
        const qs = new URLSearchParams({ limit: String(input.limit ?? 20) });
        if (input.query) qs.set('query', input.query);
        const r = await miroFetch<{ data?: Array<{ id: string; name?: string; viewLink?: string }> }>('GET', `/boards?${qs.toString()}`, undefined, { correlationId: ctx.correlationId });
        const boards = (r.data ?? []).map((b) => ({ id: b.id, name: b.name, viewLink: b.viewLink }));
        return { data: { boards, count: boards.length }, summary: `Found ${boards.length} Miro board(s).` };
      },
    },
    callerHash,
  );
}
