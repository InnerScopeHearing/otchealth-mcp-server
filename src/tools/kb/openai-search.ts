/**
 * `search` — the OpenAI ChatGPT / Deep Research MCP connector contract, read side.
 *
 * ChatGPT connectors and Deep Research require EXACTLY two tools named `search` and `fetch` (no
 * prefix — this is a fixed third-party naming contract, not this repo's convention; see
 * openai-fetch.ts for the companion tool and kb/openai-ids.ts for the composite-id scheme that
 * links them). `search(query)` returns a list of lightweight citations; `fetch(id)` returns one
 * citation's full text. Together they let ChatGPT ground an answer in the company brain and cite
 * it back — the same property brain_search/kb_search already give Claude-side callers.
 *
 * ============================ SECURITY (read before touching room selection) ============
 * This tool pair NEVER reaches a privileged room — for ANY caller, including cto/exec. That is
 * deliberately a STRICTER bar than brain_search (which lets EXEC_RING callers cross-read
 * finance/legal): search/fetch are the "any engine" contract, built to be safe to hand to an
 * external, non-Claude, non-vetted client, so room selection does two things, not one:
 *   1. Reuses `roomsFor(caller, domain)` from kb/brain-search.ts — the SAME ring-gating source of
 *      truth brain_search itself uses — never re-implements or widens it. An external ChatGPT
 *      connector authenticates via Dynamic Client Registration, which oauth.ts hard-binds to the
 *      non-privileged 'external-read' lane (see that file's SECURITY-CRITICAL Part 6 comment), so
 *      roomsFor('external-read') already resolves to OPEN_ROOMS only.
 *   2. INTERSECTS that result with NON_PRIVILEGED_ROOMS (== OPEN_ROOMS) regardless of what
 *      roomsFor returned. This is DEFENSE IN DEPTH, not deduplicated ring logic: even if
 *      roomsFor/isLaneAllowed ever had a bug that let a privileged room slip through for some
 *      caller (e.g. an EXEC_RING lane that legitimately reads finance/legal via brain_search), this
 *      intersection independently strips it back out before a room name ever reaches a search or a
 *      citation id THROUGH THIS TOOL PAIR specifically. See nonPrivilegedRoomsFor below.
 *
 * Because search NEVER queries a privileged room in the first place, it can never MINT an id that
 * points at one — but fetch (openai-fetch.ts) does NOT rely on that as its only defense: it
 * independently re-derives the room from the id and re-checks it through the SAME
 * nonPrivilegedRoomsFor on every call, so a self-constructed or replayed id can never be used to
 * reach privileged content either. See that file's header for the load-bearing check.
 *
 * OPENAI_SEARCH_MODE=off is a kill-switch (read fresh from process.env, same convention as
 * DEEP_RETRIEVAL_MODE / INCIDENT_MATCH_MODE / AUTO_JOURNAL_MODE — config/env.ts): flips this tool
 * (and its fetch companion) to a disabled response without a redeploy.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z, type ZodRawShape } from 'zod';
import { registerTool, type CallerHashProvider, type ToolContext, type ToolResultPayload } from '../registry.js';
import { hybridSearch, searchConfigured } from '../../search/index.js';
import { roomsFor, OPEN_ROOMS } from './brain-search.js';
import { rrfFuse } from '../../memory/rrf.js';
import { retractedIds, filterRetracted } from '../../memory/retractions.js';
import { buildCompositeId } from './openai-ids.js';

export type OpenAiSearchMode = 'off' | 'on';

/** The hard-capped, non-privileged room allow-set this tool pair may EVER touch. Equal to
 *  OPEN_ROOMS today, imported (not copied) so this can never silently drift from brain-search.ts's
 *  own definition of "the rooms every agent may read." */
const NON_PRIVILEGED_ROOMS = new Set<string>(OPEN_ROOMS);

/**
 * Rooms this tool pair may use for `caller`: roomsFor(caller)'s own decision, INTERSECTED with
 * NON_PRIVILEGED_ROOMS — see the file header's SECURITY section for why this is a deliberate second
 * layer, not a redundant one. Exported so openai-fetch.ts's ring re-check uses the EXACT SAME
 * predicate this tool's own room selection does; one definition, never two that could drift apart.
 */
export function nonPrivilegedRoomsFor(caller: string | undefined | null): string[] {
  return roomsFor(caller).filter((r) => NON_PRIVILEGED_ROOMS.has(r));
}

/** Parse OPENAI_SEARCH_MODE, defaulting to 'on' (fail-open toward availability, mirrors every
 *  other off|on kill-switch in this repo — see config/env.ts). Pure. Shared with openai-fetch.ts
 *  so the pair is one on/off unit, never independently toggled. */
export function parseOpenAiSearchMode(value: string | undefined): OpenAiSearchMode {
  return (value || '').trim().toLowerCase() === 'off' ? 'off' : 'on';
}

/** Results returned per query. Deliberately small — this is a citation list, not a full recall. */
const RESULT_TOP = 10;

export const openaiSearchInputShape = {
  query: z.string().min(1).describe('Natural-language search query.'),
} satisfies ZodRawShape;

export type OpenAiSearchInput = z.infer<z.ZodObject<typeof openaiSearchInputShape>>;

export interface OpenAiSearchResult {
  id: string;
  title: string;
  url: string;
  snippet?: string;
}

/** The gateway deep-link `url` a citation points at. Not fetchable by an anonymous browser (the
 *  underlying rooms are access-controlled) — a stable, inspectable reference that encodes exactly
 *  what fetch(id) will re-derive and re-check. See openai-fetch.ts. */
function citationUrl(id: string): string {
  return `otchealth-brain://${encodeURIComponent(id)}`;
}

/** Human-readable title for a hit: prefer its source path (chunked doc rooms carry one); otherwise
 *  fall back to "room: text-snippet" so a result never renders with a blank title. Pure. */
export function titleFor(room: string, path: string | undefined, text: string): string {
  if (path) return path;
  const snippet = text.trim().slice(0, 80);
  return snippet ? `${room}: ${snippet}` : room;
}

export async function handleOpenAiSearch(input: OpenAiSearchInput, ctx: ToolContext): Promise<ToolResultPayload> {
  if (parseOpenAiSearchMode(process.env.OPENAI_SEARCH_MODE) === 'off') {
    return { data: { results: [] }, summary: 'search is disabled (OPENAI_SEARCH_MODE=off).' };
  }
  if (!searchConfigured()) {
    return { data: { results: [] }, summary: 'AI Search not configured.' };
  }

  // SECURITY: the ONLY room-selection logic in this tool. nonPrivilegedRoomsFor composes roomsFor
  // (imported, never re-implemented) with the hard NON_PRIVILEGED_ROOMS cap — see the file header.
  const rooms = nonPrivilegedRoomsFor(ctx.callerAgent);
  if (rooms.length === 0) {
    return { data: { results: [] }, summary: 'No readable rooms for this caller.' };
  }

  const perRoomTop = Math.min(25, RESULT_TOP * 2);
  const settled = await Promise.allSettled(
    rooms.map(async (room) => ({ room, res: await hybridSearch(room, input.query, perRoomTop, { includeOps: false }) })),
  );
  const perRoom: Array<{ room: string; hits: Array<{ score?: number; text: string; id?: unknown; path?: string }> }> = [];
  for (const s of settled) {
    if (s.status === 'fulfilled' && s.value.res) perRoom.push({ room: s.value.room, hits: s.value.res.matches });
  }

  // Fuse a wider pool first, drop retracted beliefs, THEN trim — mirrors brain_search's own order
  // so a retracted hit never leaves a hole instead of promoting a real result into its place.
  const pool = rrfFuse(perRoom, RESULT_TOP * 3);
  const retracted = await retractedIds();
  const { kept } = filterRetracted(pool, retracted);
  const trimmed = kept.slice(0, RESULT_TOP);

  const results: OpenAiSearchResult[] = trimmed
    .filter((hit) => hit.id !== undefined && hit.id !== null && String(hit.id).length > 0)
    .map((hit) => {
      const id = buildCompositeId(hit.source, String(hit.id));
      return {
        id,
        title: titleFor(hit.source, hit.path, hit.text),
        url: citationUrl(id),
        snippet: hit.text.slice(0, 300),
      };
    });

  return {
    data: { results },
    summary: `${results.length} result(s) for "${input.query}" across ${rooms.length} non-privileged room(s): ${rooms.join(', ')}.`,
  };
}

export function registerOpenAiSearch(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(
    server,
    {
      name: 'search',
      category: 'read',
      annotations: {
        title: 'Search the OTCHealth company brain (OpenAI connector contract)',
        description:
          'OpenAI ChatGPT / Deep Research connector contract: hybrid search over the NON-PRIVILEGED company brain (never the finance/legal/memory ring rooms) and return lightweight citations {id, title, url, snippet}. Pair with fetch(id) to retrieve a citation full text. Read-only. OPENAI_SEARCH_MODE=off disables the pair fleet-wide without a redeploy.',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputShape: openaiSearchInputShape,
      outputShape: {
        results: z.array(
          z.object({
            id: z.string(),
            title: z.string(),
            url: z.string(),
            snippet: z.string().optional(),
          }),
        ),
      },
      handler: handleOpenAiSearch,
    },
    callerHash,
  );
}
