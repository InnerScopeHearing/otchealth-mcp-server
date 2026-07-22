import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, isShipLane, type CallerHashProvider } from '../registry.js';
import { isConfigured } from '../../agentstate/cosmos.js';
import { writeMemory } from '../../agentstate/memory.js';
import { MEMORY_KINDS, normalizeAgent } from '../../agentstate/agents.js';
import { indexMemoryNow } from '../../azure/search-write.js';
import { embed } from '../../azure/foundry.js';
import { detectSupersession } from '../../memory/auto-supersede-runtime.js';
import { currentCallerAgent, isConnectorSurface } from '../../server/request-context.js';
import { evaluateBroadcastMnpiGate } from '../../safety/mnpi-gate.js';

/**
 * RING GATE (defense-in-depth; layer 3 of the Phase 5/6 connector-ring closure, 2026-07-15).
 * registry.ts's per-lane connector toolset (layer 1) already HIDES memory_write from any connector
 * lane that is not cto/developer/EXEC_RING, and oauth.ts's DCR default lane (layer 2) stops an
 * unrecognized connector name from resolving to a privileged lane at all. This is the LAST line:
 * even if a future CONNECTOR_TOOLSET override, the confidential occ_ client path, or any other route
 * ever lets a non-ship-lane connector caller reach this handler, the write is still refused here,
 * fail-CLOSED, before Cosmos is ever touched.
 *
 * Pure and exported for hermetic unit testing -- mirrors isLaneAllowed() in kb/search-privileged.ts
 * and isLegalContainerAllowed() in legal/ring.ts: the caller's `connectorSurface` + `lane` stand in
 * for what isConnectorSurface() / currentCallerAgent() would report, so this can be tested without
 * spinning up the MCP server or AsyncLocalStorage request context.
 *
 * Reuses isShipLane() from registry.ts (the SAME predicate that decides whether a connector even
 * SEES memory_write) rather than re-declaring the allowed-writer set, so the two layers can never
 * silently drift apart. Returns a human-readable refusal note, or null when the write is allowed.
 *
 * Non-connector-surface callers (client_credentials fleet lanes, the static PERPLEXITY_CONNECTOR_TOKEN)
 * are UNCHANGED by this gate -- it only narrows the connector surface, which is exactly where an
 * unauthenticated/self-registered external identity can reach this tool.
 *
 * MNPI DETERMINISTIC PRE-SHARE GATE (Wave 3 item 3.5, safety/mnpi-gate.ts), an ORTHOGONAL check
 * applied in the handler below regardless of connector surface: memoryWriteRefusal above gates WHO
 * (which lane, and only over the connector surface) may write at all; the MNPI gate additionally
 * scans WHAT is being written and hard-blocks for EVERY caller, connector or not, including a normal
 * client_credentials fleet-lane agent, because this record is write-through indexed into memory-exec,
 * a room every agent's brain_search reaches. Without this second, content-based check, an ordinary
 * fleet agent (never a connector, so memoryWriteRefusal never engages) could still write EXEC_RING/
 * MNPI content straight into a room read by everyone. See mnpi-gate.ts's header for why this one gate
 * fails closed and is never mode-switched to report-only, unlike every other check in safety/.
 */
export function memoryWriteRefusal(connectorSurface: boolean, lane: string): string | null {
  if (!connectorSurface) return null;
  if (isShipLane(lane)) return null;
  return `refused: "${lane || '(none)'}" is not authorized to write fleet memory`;
}

export function registerMemoryWrite(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(
    server,
    {
      name: 'memory_write',
      category: 'write_simple',
      annotations: {
        title: 'Write a structured memory-of-record',
        description:
          'Write a durable, byte-exact, queryable memory record (fact/decision/correction/pitfall/status) to the Cosmos memory store. This is the verbatim system-of-record for memory: never lossy, never LLM-rewritten. It is ALSO write-through indexed into the semantic brain, so it is immediately recallable via brain_search/kb_search (before 2026-07-14 it was durable but INVISIBLE to every semantic recall path). Non-PHI, non-MNPI, non-privileged (clo-personal rejected). Over a Claude Chat connector surface, only the cto/developer/executive-ring lanes may write. MNPI GATE (hard, code-level, every caller including client_credentials fleet lanes): text/tags/source are scanned for an EXEC_RING-gated room reference or an explicit MNPI marker BEFORE the write; a match is refused outright, because this record is broadly recallable via brain_search. Pass dry_run=false to persist.',
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
        const refusal = memoryWriteRefusal(isConnectorSurface(), currentCallerAgent());
        if (refusal) {
          return {
            data: { written: false, note: refusal },
            summary: `Refused: connector lane "${currentCallerAgent() || '(none)'}" is not authorized to write fleet memory. Only the executive ring plus cto/developer may write memory over a connector surface.`,
          };
        }
        // MNPI DETERMINISTIC PRE-SHARE GATE (Wave 3 item 3.5, safety/mnpi-gate.ts). Runs for EVERY
        // caller, connector or not (see the file-header note above memoryWriteRefusal for why this is
        // an orthogonal, always-on check). The record is write-through indexed into memory-exec, a
        // room every agent's brain_search reaches: a content match is a HARD BLOCK, no exception.
        const mnpiGate = evaluateBroadcastMnpiGate({ text: input.text, tags: (input.tags ?? []).join(' '), source: input.source, agent: input.agent });
        if (mnpiGate.blocked) {
          return {
            data: { written: false, note: mnpiGate.reason },
            summary: `Refused: ${mnpiGate.reason}`,
          };
        }
        if (!isConfigured()) return { data: { written: false, note: 'agent-state Cosmos not configured.' }, summary: 'Memory store not configured.' };
        if (ctx.dryRun) return { data: { written: false, preview: input, note: 'dry_run: pass dry_run=false to persist.' }, summary: `DRY RUN: would write a ${input.kind} for ${input.agent}.` };
        // Embed ONCE and reuse for both auto-supersession detection and the index write below.
        let vector: number[] | null = null;
        try { vector = await embed(input.text); } catch { vector = null; }
        // AUTO-SUPERSESSION (W1-2): does this new entry contradict a near-prior same-agent one? Fail-open
        // (never blocks/breaks the write); sets supersedes only under MEMORY_AUTOSUPERSEDE_MODE=auto; and
        // NEVER overrides an explicit caller-provided supersedes (the agent already knows what it retires).
        const sup = input.supersedes
          ? { action: 'none' as const, reason: 'caller set supersedes', supersedeId: undefined as string | undefined }
          : await detectSupersession({ agent: normalizeAgent(input.agent), kind: input.kind, text: input.text, vector });
        const supersedes = input.supersedes ?? (sup.action === 'auto-link' ? sup.supersedeId : undefined);
        const record = await writeMemory({ ...input, supersedes });
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
            record,
            indexed: idx.indexed,
            ...(idx.reason ? { index_error: idx.reason } : {}),
            ...(sup.action !== 'none' ? { supersede: sup } : {}),
          },
          summary: `Wrote ${input.kind} ${record.id} to ${input.agent}'s memory-of-record${idx.indexed ? ' and indexed it for semantic recall' : ` (⚠ NOT indexed: ${idx.reason} — it will remain invisible to brain_search)`}.${supNote}`,
          audit: { after: record },
        };
      },
    },
    callerHash,
  );
}
