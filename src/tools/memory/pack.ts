import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { isConfigured, normalizeAgent, readSharedAll, type MemoryEntry } from '../../memory/store.js';

/**
 * memory_pack — one-call working-set loader for ANY client/platform. Given an agent lane, returns
 * the durable context that agent should boot with: its latest status, its corrections (current
 * truths that override older belief), recent decisions, and recent facts/pitfalls. This is the
 * cross-platform replacement for Claude Code's per-prompt memory injection (which Hyperagent /
 * ChatGPT / Perplexity etc. do not have): a new or existing agent calls memory_pack on wake and
 * is immediately current. Ring-safe: reads only the shared exec feed.
 */
export function registerMemoryPack(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(
    server,
    {
      name: 'memory_pack',
      category: 'read',
      annotations: {
        title: 'Load an agent working set',
        description:
          'Boot context for an agent in one call: latest status + corrections (current truths) + recent decisions + recent facts/pitfalls from the shared brain. Call this on wake on ANY platform so the agent is immediately up to date. Ring-safe (shared feed only).',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputShape: {
        agent: z.string().describe('Agent lane to load (lowercase id, e.g. "cto", "cfo", "developer").'),
        recent_limit: z.number().int().min(1).max(80).optional().describe('Max recent entries to include (default 30).'),
      },
      outputShape: {
        agent: z.string(),
        status: z.unknown(),
        corrections: z.array(z.unknown()),
        decisions: z.array(z.unknown()),
        recent: z.array(z.unknown()),
        count: z.number(),
      },
      handler: async (input) => {
        const agent = normalizeAgent(input.agent);
        if (!isConfigured()) {
          return {
            data: { agent, status: null, corrections: [], decisions: [], recent: [], count: 0 },
            summary: 'Shared brain not configured; empty pack.',
          };
        }
        const recentLimit = input.recent_limit ?? 30;
        const mine = (await readSharedAll()).filter((r) => r.agent === agent); // already newest-first
        const status = mine.find((r) => r.type === 'status') ?? null;
        const corrections = mine.filter((r) => r.type === 'correction').slice(0, 15);
        const decisions = mine.filter((r) => r.type === 'decision').slice(0, 15);
        const recent = mine.slice(0, recentLimit);
        return {
          data: { agent, status, corrections, decisions, recent, count: mine.length },
          summary: `pack(${agent}): ${mine.length} entries — ${corrections.length} corrections, ${decisions.length} decisions${status ? ', status present' : ''}.`,
        };
      },
    },
    callerHash,
  );
}
