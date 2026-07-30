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
 * Also carries an UNCONDITIONAL clo-personal hard block, connector surface or not (see the
 * clo-personal branch below) -- see memoryWriteIdentityRefusal's header for the companion bug this
 * closes (identity forgery via the input.agent field), found and fixed in the same pass, 2026-07-30.
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
  // UNCONDITIONAL, regardless of connector surface -- matches this tool's own docstring ("non-
  // privileged, clo-personal rejected"), which was previously aspirational prose only: agents.ts's
  // shared normalizeAgent() FORBIDDEN_AGENTS set is empty by design (it is used by every read/write
  // path in the fleet, including clo-personal's own legitimate self-reads, so populating it there
  // would break clo-personal's normal operation, not just memory_write). The block belongs HERE,
  // local to the one tool where clo-personal content must never land: memory_write is write-through
  // indexed into memory-exec, a room every lane's brain_search reaches, so a clo-personal-authenticated
  // caller writing under its own true identity would still leak privileged content onto the broadcast
  // surface -- distinct from, and in addition to, the identity-forgery gap memoryWriteIdentityRefusal
  // closes below. Found + fixed together, 2026-07-30.
  if ((lane || '').trim().toLowerCase() === 'clo-personal') {
    return '"clo-personal" is a privilege-walled personal-legal lane and may never write to memory_write\'s broadly-shared, brain_search-recallable memory-of-record (use memory_remember\'s ring-gated personal channels instead, if one exists for this content)';
  }
  if (!connectorSurface) return null;
  if (isShipLane(lane)) return null;
  return `"${lane || '(none)'}" is not authorized to write fleet memory over a connector surface`;
}

/**
 * IDENTITY-FORGERY GATE (found + fixed 2026-07-30, alongside the clo-personal block above).
 *
 * THE BUG: the handler used to pass `input.agent` -- an ordinary, entirely caller-supplied string
 * field -- straight through to writeMemory() as the record's `agent` attribution, with NO check
 * against the caller's actual authenticated identity (ctx.callerAgent / currentCallerAgent(), sourced
 * from the caller's own OAuth/static token, see server/request-context.ts). Any caller with reachable
 * access to memory_write (every non-connector client_credentials fleet lane; memoryWriteRefusal above
 * only gates WHO may call, not what identity the write claims) could write a byte-exact, verbatim,
 * broadly-recallable "system-of-record" entry -- read by every agent's wake()/brain_search as
 * authoritative ground truth -- and attribute it to ANY OTHER lane, e.g. a low-privilege lane calling
 * memory_write({agent:"cto", kind:"decision", text:"..."}) to inject a forged decision that every
 * other agent, including cto/clo/cfo, would treat as genuine. This is meaningfully worse than
 * memory_remember's cross-lane note feature, which is the same shape of "who does this land under"
 * question but handles it safely: remember.ts ALWAYS derives the true writer from ctx.callerAgent
 * into a separate, always-shown `by` field, and only lets input.agent choose the TARGET feed, so a
 * forged attribution is structurally impossible there. memory_write had no such separation -- its
 * one identity field was the spoofable one.
 *
 * THE FIX: memory_write is not documented anywhere as a cross-lane tool (unlike memory_remember, which
 * explicitly is), so the correct behavior is self-write-only. Refuse LOUDLY on any mismatch between
 * the caller's authenticated identity and the requested `agent`, rather than silently substituting one
 * for the other -- consistent with this file's existing fail-closed conventions (memoryWriteRefusal,
 * the MNPI gate). Also refuse when no identity resolved at all (callerAgent === ''): a memory-of-record
 * write attributed to an unidentified caller is exactly the same unverifiable-provenance problem, just
 * with no requested value to even compare against. The handler additionally writes using callerAgent
 * directly (never input.agent) as defense in depth, so a future weakening of this gate alone cannot
 * reopen the hole.
 *
 * Pure and exported for hermetic unit testing, mirroring memoryWriteRefusal's shape.
 */
export function memoryWriteIdentityRefusal(callerAgent: string, requestedAgent: string): string | null {
  const caller = (callerAgent || '').trim().toLowerCase();
  const requested = (requestedAgent || '').trim().toLowerCase();
  if (!caller) {
    return 'no verifiable agent identity on this token -- memory_write cannot attribute a system-of-record entry to an unidentified caller';
  }
  if (requested && requested !== caller) {
    // Reviewer-caught, 2026-07-30: `agent` is a REQUIRED input field (see the zod inputShape below),
    // so "omit it" was never actually a viable recovery step -- only tell the caller to pass their
    // own authenticated identity.
    return `your authenticated identity is "${caller}" but this call requested agent "${requested}" -- memory_write always attributes the record to YOUR OWN authenticated identity, never a caller-supplied value (this is not memory_remember's cross-lane feature; pass agent="${caller}")`;
  }
  return null;
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
          'Write a durable, byte-exact, queryable memory record (fact/decision/correction/pitfall/status) to the Cosmos memory store. This is the verbatim system-of-record for memory: never lossy, never LLM-rewritten. It is ALSO write-through indexed into the semantic brain, so it is immediately recallable via brain_search/kb_search (before 2026-07-14 it was durable but INVISIBLE to every semantic recall path). Non-PHI, non-MNPI, non-privileged (clo-personal rejected, code-enforced). SELF-WRITE ONLY: unlike memory_remember, this tool has no cross-lane feature -- the record is always attributed to YOUR OWN authenticated token identity; a mismatched `agent` value is refused outright as a forgery attempt, not silently substituted (fixed 2026-07-30). Over a Claude Chat connector surface, only the cto/developer/executive-ring lanes may write. MNPI GATE (hard, code-level, every caller including client_credentials fleet lanes): text/tags/source are scanned for an EXEC_RING-gated room reference or an explicit MNPI marker BEFORE the write; a match is refused outright, because this record is broadly recallable via brain_search. Pass dry_run=false to persist.',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      inputShape: {
        agent: z.string().describe('Your own agent lane (lowercase id) -- must match your authenticated token identity; memory_write is self-write-only.'),
        kind: z.enum(MEMORY_KINDS).describe('fact, decision, correction, pitfall, or status.'),
        text: z.string().min(1).describe('The atomic, non-sensitive memory text.'),
        tags: z.array(z.string()).optional(),
        source: z.string().optional().describe('Optional attribution, e.g. "Matt 2026-07-01".'),
        supersedes: z.string().optional().describe('Optional: the id of an entry this one REPLACES (e.g. "20260713-015"). Set it ONLY when this entry makes the older one FALSE, not merely related -- readers (wake, memory_pack) DROP the superseded entry so a retracted belief cannot resurface as a live truth. Use it whenever you correct a previously-stated fact.'),
      },
      outputShape: { written: z.boolean(), record: z.unknown() },
      handler: async (input, ctx) => {
        const callerAgent = currentCallerAgent();
        // Returns the ACTUAL refusal reason in the summary rather than a hardcoded "connector lane
        // ... executive ring" sentence -- fixed 2026-07-30 review: that hardcoded text was wrong for
        // the clo-personal branch (clo-personal IS an executive-ring member, and the block fires
        // unconditionally, connector surface or not), so the old summary told a refused clo-personal
        // caller it was refused for being outside a ring it is actually inside, on a surface it may
        // not have even been using. Every memoryWriteRefusal return value is a complete, correctly-
        // worded explanation on its own (see that function's two return sites).
        const refusal = memoryWriteRefusal(isConnectorSurface(), callerAgent);
        if (refusal) {
          return {
            data: { written: false, note: refusal },
            summary: `Refused: ${refusal}`,
          };
        }
        // IDENTITY-FORGERY GATE (memoryWriteIdentityRefusal's header has the full story): memory_write
        // is self-write-only, so a requested `agent` that does not match the caller's own authenticated
        // identity is refused outright rather than silently trusted or silently overridden.
        const identityRefusal = memoryWriteIdentityRefusal(callerAgent, input.agent);
        if (identityRefusal) {
          return {
            data: { written: false, note: identityRefusal },
            summary: `Refused: ${identityRefusal}`,
          };
        }
        // MNPI DETERMINISTIC PRE-SHARE GATE (Wave 3 item 3.5, safety/mnpi-gate.ts). Runs for EVERY
        // caller, connector or not (see the file-header note above memoryWriteRefusal for why this is
        // an orthogonal, always-on check). The record is write-through indexed into memory-exec, a
        // room every agent's brain_search reaches: a content match is a HARD BLOCK, no exception.
        const mnpiGate = evaluateBroadcastMnpiGate({ text: input.text, tags: (input.tags ?? []).join(' '), source: input.source, agent: callerAgent });
        if (mnpiGate.blocked) {
          return {
            data: { written: false, note: mnpiGate.reason },
            summary: `Refused: ${mnpiGate.reason}`,
          };
        }
        if (!isConfigured()) return { data: { written: false, note: 'agent-state Cosmos not configured.' }, summary: 'Memory store not configured.' };
        if (ctx.dryRun) return { data: { written: false, preview: { ...input, agent: callerAgent }, note: 'dry_run: pass dry_run=false to persist.' }, summary: `DRY RUN: would write a ${input.kind} for ${callerAgent}.` };
        // Embed ONCE and reuse for both auto-supersession detection and the index write below.
        let vector: number[] | null = null;
        try { vector = await embed(input.text); } catch { vector = null; }
        // AUTO-SUPERSESSION (W1-2): does this new entry contradict a near-prior same-agent one? Fail-open
        // (never blocks/breaks the write); sets supersedes only under MEMORY_AUTOSUPERSEDE_MODE=auto; and
        // NEVER overrides an explicit caller-provided supersedes (the agent already knows what it retires).
        // Uses callerAgent, not input.agent -- see memoryWriteIdentityRefusal's header (defense in depth:
        // the two are guaranteed equal past the gate above, but sourcing from the authenticated value
        // here too means a future weakening of that gate alone still cannot misattribute a write).
        const sup = input.supersedes
          ? { action: 'none' as const, reason: 'caller set supersedes', supersedeId: undefined as string | undefined }
          : await detectSupersession({ agent: normalizeAgent(callerAgent), kind: input.kind, text: input.text, vector });
        const supersedes = input.supersedes ?? (sup.action === 'auto-link' ? sup.supersedeId : undefined);
        // agent: callerAgent (never input.agent) -- the same defense-in-depth reasoning as the
        // detectSupersession call above; this is the actual persisted attribution.
        const record = await writeMemory({ ...input, agent: callerAgent, supersedes });
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
          summary: `Wrote ${input.kind} ${record.id} to ${record.agent}'s memory-of-record${idx.indexed ? ' and indexed it for semantic recall' : ` (⚠ NOT indexed: ${idx.reason} — it will remain invisible to brain_search)`}.${supNote}`,
          audit: { after: record },
        };
      },
    },
    callerHash,
  );
}
