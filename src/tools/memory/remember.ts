import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { appendShared, isConfigured, normalizeAgent, type MemoryEntry } from '../../memory/store.js';
import { indexMemory as indexMemoryNow } from '../../search/index.js';
import { embed } from '../../azure/foundry.js';
import { detectSupersession } from '../../memory/auto-supersede-runtime.js';
import { evaluateBroadcastMnpiGate } from '../../safety/mnpi-gate.js';

const TYPES = ['fact', 'decision', 'correction', 'pitfall', 'status'] as const;

export function registerMemoryRemember(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(
    server,
    {
      name: 'memory_remember',
      category: 'write_simple',
      annotations: {
        title: 'Write to the shared brain',
        description:
          'Append an entry to the cross-agent shared memory (kb-memory commons feed) so every connected AI sees it. Use for a fact, decision, correction, pitfall, or status. Set "agent" to write ON ANOTHER lane\'s feed (a cross-lane note / hand-off): it is APPEND-ONLY and auto-attributed to YOUR token identity (by=<you>), and the target lane sees it via memory_inbound and acks with memory_reconcile on wake. Omit "agent" to write your own feed. Writes ONLY to the shared, non-sensitive commons feed: never put MNPI (INND) or PHI (MedReview) detail here. CORRECTED 2026-07-29 (a prior version of this description said the 2026-07-07 clo-personal change "suspended ring-gating fleet-wide" -- that was inaccurate and is retracted here: it does not describe the enforcement below, which was never suspended). MNPI GATE (hard, code-level, not just this instruction, enforced for every caller with no exception and no suspension, past or present): text/tags/source are scanned for an EXEC_RING-gated room reference or an explicit MNPI marker BEFORE the write; a match is refused for every caller, because the commons feed is always broadly shared and non-privileged.',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      inputShape: {
        agent: z
          .string()
          .optional()
          .describe('The agent lane to publish under; defaults to your token identity (lowercase id, e.g. "cto", "commerce").'),
        type: z
          .union([z.enum(TYPES), z.literal('finding')])
          .transform((v) => (v === 'finding' ? 'fact' : v))
          .describe('Entry kind: fact, decision, correction, pitfall, or status. "finding" is accepted as an alias for "fact".'),
        text: z.string().min(1).describe('The fact/decision/correction/pitfall/status text. Keep it atomic and non-sensitive.'),
        tags: z.array(z.string()).optional().describe('Optional tags for recall, e.g. ["ebay","pricing"].'),
        source: z.string().optional().describe('Optional attribution, e.g. "Matt 2026-06-20".'),
        supersedes: z.string().optional().describe('Optional: the id of an entry this one REPLACES (e.g. "20260713-015"). Set it ONLY when this entry makes the older one FALSE, not merely related -- readers (wake, memory_pack) DROP the superseded entry so a retracted belief cannot resurface as a live truth. Use it whenever you correct a previously-stated fact.'),
      },
      outputShape: {
        written: z.boolean(),
        entry: z.unknown(),
        note: z.string().optional(),
      },
      handler: async (input, ctx) => {
        // MNPI DETERMINISTIC PRE-SHARE GATE (Wave 3 item 3.5, safety/mnpi-gate.ts). Runs BEFORE any
        // store write. The commons feed is, by construction, always broadly shared/non-privileged:
        // a match is a HARD BLOCK for every caller, including an EXEC_RING lane writing its own feed.
        const mnpiGate = evaluateBroadcastMnpiGate({ text: input.text, tags: (input.tags ?? []).join(' '), source: input.source, agent: input.agent });
        if (mnpiGate.blocked) {
          return {
            data: { written: false, entry: null, note: mnpiGate.reason },
            summary: `Refused: ${mnpiGate.reason}`,
          };
        }
        if (!isConfigured()) {
          return {
            data: { written: false, entry: null, note: 'Shared brain not configured (AZURE_COMMONS_STORAGE_ACCOUNT/KEY unset).' },
            summary: 'Memory store not configured; nothing written.',
          };
        }
        const agent = normalizeAgent(input.agent || ctx.callerAgent);
        // The WRITER is the authenticated caller (from the token), never a spoofable param. When the
        // target feed (agent) differs from the writer, it's an attributed, append-only CROSS-LANE note.
        let by = '';
        try { by = ctx.callerAgent ? normalizeAgent(ctx.callerAgent) : ''; } catch { by = ''; }
        const cross = Boolean(by && by !== agent);
        if (ctx.dryRun) {
          const preview: Omit<MemoryEntry, 'id' | 'ts'> = {
            type: input.type,
            text: input.text,
            tags: input.tags ?? [],
            agent,
            ...(input.source ? { source: input.source } : {}),
            ...(cross ? { by } : {}),
            ...(input.supersedes ? { supersedes: input.supersedes } : {}),
          };
          return {
            data: { written: false, entry: preview, note: 'dry_run: not written. Pass dry_run=false to persist.' },
            summary: cross ? `DRY RUN: would write a cross-lane ${input.type} BY ${by} ON ${agent}'s feed.` : `DRY RUN: would publish a ${input.type} to ${agent}'s shared feed.`,
          };
        }
        // Embed ONCE and reuse for both auto-supersession detection and the index write below.
        let vector: number[] | null = null;
        try { vector = await embed(input.text); } catch { vector = null; }
        // AUTO-SUPERSESSION (W1-2): does this new entry contradict a near-prior entry on the TARGET
        // lane's feed? Fail-open (never blocks/breaks the append); sets supersedes only under
        // MEMORY_AUTOSUPERSEDE_MODE=auto; never overrides an explicit caller-provided supersedes.
        const sup = input.supersedes
          ? { action: 'none' as const, reason: 'caller set supersedes', supersedeId: undefined as string | undefined }
          : await detectSupersession({ agent, kind: input.type, text: input.text, vector });
        const supersedes = input.supersedes ?? (sup.action === 'auto-link' ? sup.supersedeId : undefined);
        const entry = await appendShared(agent, input.type, input.text, input.tags ?? [], input.source, by || undefined, supersedes);
        // WRITE-THROUGH: make it semantically searchable NOW, not in up to 6 hours when brain-reindex
        // next runs. Fail-open -- the entry is already durable in blob, and the 6-hourly reindex is
        // the backstop, so an index outage must never fail the write. We report the outcome rather
        // than swallowing it: a silent indexing failure is exactly how we lost 12 days of recall.
        const idx = await indexMemoryNow({
          agent,
          id: entry.id,
          type: entry.type,
          ts: entry.ts,
          tags: entry.tags,
          text: entry.text,
          vector,
        });
        const supNote =
          sup.action === 'auto-link'
            ? ` Auto-superseded ${sup.supersedeId} (contradiction detected).`
            : sup.action === 'suggest'
              ? ` Possible contradiction with ${sup.supersedeId} flagged for reconcile.`
              : '';
        return {
          data: {
            written: true,
            entry,
            indexed: idx.indexed,
            ...(idx.reason ? { index_error: idx.reason } : {}),
            ...(sup.action !== 'none' ? { supersede: sup } : {}),
          },
          summary:
            (cross
              ? `Cross-lane ${input.type} ${entry.id} written BY ${by} ON ${agent}'s feed (append-only, attributed). ${agent} sees it via memory_inbound on next wake.`
              : `Published ${input.type} ${entry.id} to ${agent}'s shared feed${idx.indexed ? ' and indexed it for instant semantic recall' : ` (⚠ NOT indexed: ${idx.reason} — searchable after the next brain-reindex)`}.`) +
            supNote,
          audit: { after: entry },
        };
      },
    },
    callerHash,
  );
}
