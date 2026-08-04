/**
 * Ring-gating for the legal document store (legal_blob_* tools).
 *
 * The legal blob containers map 1:1 onto the RING-GATED AI-Search indexes already governed by
 * kb_search_privileged, and MUST be gated identically — never more broadly:
 *
 *   container `personal` -> the `legal-personal` ring  (MOST SENSITIVE: attorney-privileged
 *                            CA divorce/civil matters, incl. minors' data)
 *   container `company`  -> the `legal-company` ring
 *
 * We deliberately DERIVE these lanes from INDEX_LANES in kb/search-privileged.ts (the single source
 * of truth for the executive ring) rather than re-declaring a lane list here. That guarantees the
 * blob gate can never silently drift from the search-index gate: widening one without the other is
 * impossible, because there is only one array. Any future change to the privileged ring is a single
 * reviewable diff in search-privileged.ts + its pinned test.
 *
 * PERSONAL-LEGAL RING (code-of-record, Matt direction 2026-07-16): the `personal` container maps to the
 * `legal-personal` index, which search-privileged.ts gates to PERSONAL_LEGAL_RING = ['clo-personal','exec']
 * This is strictly NARROWER than the exec ring. The individual chiefs (cfo/cpo/cco) and the company-legal
 * 'clo' lane are STRIPPED; only the dedicated personal-legal lane and the unified One-Brain chief may read
 * it. Because lanesForContainer('personal') DERIVES from INDEX_LANES below, this blob gate inherits that
 * ring automatically — the two access paths to the same privileged corpus can never drift. The `company`
 * container keeps the full exec ring. Any future ring-width change is a single reviewable diff in
 * search-privileged.ts INDEX_LANES and it flows to both the search tool and these blob tools.
 *
 * COO/CRO (2026-07-21): removed from EXEC_RING entirely (see search-privileged.ts), so they no longer
 * reach the `company` container either, not only `personal`. Least-privilege, Matt direction.
 */

import { INDEX_LANES } from '../kb/search-privileged.js';
import { loadEnv } from '../../config/env.js';

export type LegalContainer = 'company' | 'personal';

/** The AI-Search index whose ring governs each container. */
const CONTAINER_INDEX: Record<LegalContainer, string> = {
  company: 'legal-company',
  personal: 'legal-personal',
};

/** The exact lanes permitted on a legal container — derived from the sibling privileged index. */
export function lanesForContainer(container: LegalContainer): string[] {
  return INDEX_LANES[CONTAINER_INDEX[container]] ?? [];
}

/**
 * Pure ring-enforcement predicate for the legal blob store, exported for unit testing without
 * spinning up the MCP server. Mirrors isLaneAllowed() in kb/search-privileged.ts: an unknown/absent
 * caller ('' / undefined / null) is always refused.
 */
export function isLegalContainerAllowed(
  container: LegalContainer,
  caller: string | undefined | null,
): boolean {
  const lanes = lanesForContainer(container);
  return Boolean(caller) && lanes.includes(caller as string);
}

/**
 * Protected-prefix guard for destructive/relocating operations (legal_blob_delete,
 * legal_blob_move) — see LEGAL_PROTECTED_PREFIXES in env.ts for the full rationale. A path is
 * protected when it falls under any configured prefix, checked case-sensitively (Azure blob names
 * are case-sensitive) after stripping a leading slash. Pure + exported for unit testing.
 */
export function protectedPrefixes(): string[] {
  const env = loadEnv();
  return env.LEGAL_PROTECTED_PREFIXES.split(',').map((s) => s.trim()).filter(Boolean);
}

export function isProtectedPath(path: string): boolean {
  const normalized = path.replace(/^\/+/, '');
  return protectedPrefixes().some((prefix) => normalized.startsWith(prefix));
}
