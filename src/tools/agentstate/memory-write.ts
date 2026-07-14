import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { isConfigured } from '../../agentstate/cosmos.js';
import { writeMemory } from '../../agentstate/memory.js';
import { MEMORY_KINDS } from '../../agentstate/agents.js';
import { indexMemoryNow } from '../../azure/search-write.js';

export function registerMemoryWrite(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(
    server,
    {
      name: 'memory_write',
      category: 'write_simple',
      annotations: {
        title: 'Write a structured memory-of-record',
        description:
          'Write a durable, byte-exact, queryable memory record (fact/decision/correction/pitfall/status) to the Cosmos memory store. This is the verbatim system-of-record for memory: never lossy, never LLM-rewritten. It is ALSO write-through indexed into the semantic brain, so it is immediately recallable via brain_search/kb_search (before 2026-07-14 it was durable but INVISIBLE to every semantic recall path). Non-PHI, non-MNPI, non-privileged (clo-personal rejected). Pass dry_run=false to persist.',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      inputShape: {
        agent: z.string().describe('Agent lane (lowercase id).'),
        kind: z.enum(MEMORY_KINDS).describe('fact, decision, correction, pitfall, or status.'),
        text: z.string().min(1).describe('The atomic, non-sensitive memory text.'),
        tags: z.array(z.string()).optional(),
        source: z.string().optional().describe('Optional attribution, e.g. "Matt 2026-07-01".'),
        supersedes: z.string().optional().describe('Optional: the id of an entry this one REPLACES (e.g. "20260713-015"). Set it ONLY when this entry makes the older one FALSE, not merely related -- readers (wake, memory_pack) DROP the superseded entry so a retracted belief cannot resurface as a live truth. Use it whenever you correct a previously-stated fact.'),
      },
      outputShape: { written: z.boolean(), record: z.unknown() },
      handler: async (input, ctx) => {
        if (!isConfigured()) return { data: { written: false, note: 'agent-state Cosmos not configured.' }, summary: 'Memory store not configured.' };
        if (ctx.dryRun) return { data: { written: false, preview: input, note: 'dry_run: pass dry_run=false to persist.' }, summary: `DRY RUN: would write a ${input.kind} for ${input.agent}.` };
        const record = await writeMemory(input);
        // WRITE-THROUGH: the Cosmos memory-of-record was previously indexed by NOTHING -- semantic.mjs
        // indexes only the shared blob feed, so every memory_write was durable but UNFINDABLE by
        // brain_search/kb_search. This makes the system-of-record actually recallable. Fail-open:
        // the record is already committed to Cosmos, so an index outage must never fail the write.
        const idx = await indexMemoryNow({
          agent: record.agent,
          id: record.id,
          type: record.kind,
          ts: record.created_at,
          tags: record.tags,
          text: record.text,
        });
        return {
          data: { written: true, record, indexed: idx.indexed, ...(idx.reason ? { index_error: idx.reason } : {}) },
          summary: `Wrote ${input.kind} ${record.id} to ${input.agent}'s memory-of-record${idx.indexed ? ' and indexed it for semantic recall' : ` (⚠ NOT indexed: ${idx.reason} — it will remain invisible to brain_search)`}.`,
          audit: { after: record },
        };
      },
    },
    callerHash,
  );
}
