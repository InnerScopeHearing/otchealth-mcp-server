/**
 * `fetch` — the OpenAI ChatGPT / Deep Research MCP connector contract, read side (full text).
 * Companion to `search` (openai-search.ts); see that file's header for the shared contract and why
 * these two tool NAMES (no prefix) are fixed by the third-party OpenAI connector spec.
 *
 * ============================ SECURITY (the load-bearing check in this file) ============
 * `id` is UNTRUSTED CALLER INPUT. It is never trusted merely because it looks like something
 * `search` could have returned — an external caller can construct, replay, or guess ANY string.
 * Concretely: a legal-personal or finance-cfo-* composite id (copied from another agent's output,
 * brute-forced from a known doc path, or simply hand-typed) presented by a non-privileged caller
 * MUST be refused, even though `search` itself would never have MINTED that id for that caller.
 *
 * THE DEFENSE: every call re-derives the room from the id (parseCompositeId) and re-checks it
 * against `nonPrivilegedRoomsFor(ctx.callerAgent)` (openai-search.ts) — the EXACT SAME predicate
 * that tool's own room selection uses: roomsFor() (kb/brain-search.ts's ring-gating source of
 * truth), INTERSECTED with the hard non-privileged allow-set. Imported, never re-implemented, and
 * never just roomsFor() alone — see openai-search.ts's header for why the intersection is a
 * deliberate second layer: this tool pair must never serve a privileged room even to a caller whose
 * ring WOULD normally get one via brain_search (e.g. an EXEC_RING lane). The check runs BEFORE
 * calling getDocumentByKey. A room not in that intersected set is refused with forbidden_ring, full
 * stop; the document is never even requested from Azure Search. This makes the check independent of
 * whatever `search` did or did not return in some earlier call, which is the actual property being
 * defended: fetch does not trust search, fetch does not trust the id, fetch re-derives and
 * re-checks itself, on every single call.
 *
 * Fail-CLOSED on an unparseable id, an empty/unknown caller, or a room the caller cannot prove
 * access to (nonPrivilegedRoomsFor(undefined) / (''): resolves to the open rooms only, same as
 * brain_search's own roomsFor — there is no identity for which this check can be bypassed, and no
 * identity for which it can widen past the non-privileged cap). Fail-OPEN only on infra errors that
 * occur AFTER the ring check has already passed (a Search outage degrades to "not found", never to
 * "let it through").
 *
 * OPENAI_SEARCH_MODE=off (the SAME kill-switch openai-search.ts reads) also disables fetch — the
 * pair is one on/off unit, never independently toggled, so there is no fetch-without-search half
 * state.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z, type ZodRawShape } from 'zod';
import { registerTool, type CallerHashProvider, type ToolContext, type ToolResultPayload } from '../registry.js';
import { getDocumentByKey, searchConfigured } from '../../azure/search.js';
import { parseCompositeId } from './openai-ids.js';
import { parseOpenAiSearchMode, nonPrivilegedRoomsFor } from './openai-search.js';

export const openaiFetchInputShape = {
  id: z.string().min(1).describe('The opaque id returned by search(), e.g. "memory-exec::cto__142".'),
} satisfies ZodRawShape;

export type OpenAiFetchInput = z.infer<z.ZodObject<typeof openaiFetchInputShape>>;

function fetchUrl(id: string): string {
  return `otchealth-brain://${encodeURIComponent(id)}`;
}

/** A refused/empty result, in the exact OpenAI {id, title, text, url, metadata} shape. Keeping the
 *  string fields present-but-empty (rather than omitting them) is deliberate: a caller that expects
 *  the contract's required fields should never have to special-case a refusal shape. */
function refusal(id: string, errorCode: string): { id: string; title: string; text: string; url: string; metadata: Record<string, unknown> } {
  return { id, title: '', text: '', url: fetchUrl(id), metadata: { error: errorCode } };
}

export async function handleOpenAiFetch(input: OpenAiFetchInput, ctx: ToolContext): Promise<ToolResultPayload> {
  if (parseOpenAiSearchMode(process.env.OPENAI_SEARCH_MODE) === 'off') {
    return { data: refusal(input.id, 'disabled'), summary: 'fetch is disabled (OPENAI_SEARCH_MODE=off).' };
  }

  const parsed = parseCompositeId(input.id);
  if (!parsed) {
    return { data: refusal(input.id, 'malformed_id'), summary: `Refused: "${input.id}" is not a valid composite id.` };
  }

  // ── THE LOAD-BEARING RING CHECK ──────────────────────────────────────────────────────────────
  // Re-derive the room from the id and re-check it against what THIS caller may read RIGHT NOW,
  // through the SAME hard-capped, non-privileged predicate search.ts's own room selection uses.
  // Never trust that the id came from this caller's own earlier search() call — fail-closed on an
  // empty/unknown caller too, since nonPrivilegedRoomsFor(undefined | '') already resolves to the
  // open rooms only (no identity escalates past that, and no identity widens past the cap either).
  const permitted = new Set(nonPrivilegedRoomsFor(ctx.callerAgent));
  if (!permitted.has(parsed.room)) {
    return {
      data: refusal(input.id, 'forbidden_ring'),
      summary:
        `Refused: room "${parsed.room}" is not readable by your identity` +
        `${ctx.callerAgent ? ` (${ctx.callerAgent})` : ' (no identity on this token)'}. ` +
        'Privileged data is never served through this tool.',
    };
  }
  // ──────────────────────────────────────────────────────────────────────────────────────────────

  if (!searchConfigured()) {
    return { data: refusal(input.id, 'unconfigured'), summary: 'AI Search not configured.' };
  }

  try {
    const doc = await getDocumentByKey(parsed.room, parsed.key);
    if (!doc || !doc.text) {
      return { data: refusal(input.id, 'not_found'), summary: `No document found for "${input.id}".` };
    }
    const title = doc.title || parsed.key;
    return {
      data: {
        id: input.id,
        title,
        text: doc.text,
        url: fetchUrl(input.id),
        metadata: { room: parsed.room, path: doc.path, mode: doc.mode },
      },
      summary: `Fetched "${title}" from ${parsed.room} (${doc.text.length} chars).`,
    };
  } catch (e) {
    // Fail-open ONLY here — after the ring check already passed. An Azure Search outage degrades
    // to a normal-shaped "not found"-style refusal, never a thrown error the caller must parse.
    const msg = e instanceof Error ? e.message : String(e);
    return { data: refusal(input.id, 'fetch_failed'), summary: `Fetch failed: ${msg}.` };
  }
}

export function registerOpenAiFetch(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(
    server,
    {
      name: 'fetch',
      category: 'read',
      annotations: {
        title: 'Fetch a company-brain citation by id (OpenAI connector contract)',
        description:
          'OpenAI ChatGPT / Deep Research connector contract: resolve an id returned by search() into its full text for citation. Re-derives the source room from the id and RE-CHECKS it against your ring on every call -- a privileged-room id presented by a non-privileged caller is refused (forbidden_ring), regardless of where the id came from. Read-only. OPENAI_SEARCH_MODE=off disables the pair fleet-wide without a redeploy.',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputShape: openaiFetchInputShape,
      outputShape: {
        id: z.string(),
        title: z.string(),
        text: z.string(),
        url: z.string(),
        metadata: z.record(z.unknown()).optional(),
      },
      handler: handleOpenAiFetch,
    },
    callerHash,
  );
}
