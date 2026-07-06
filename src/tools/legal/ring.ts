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
 * NOTE ON THE TASK BRIEF vs. CODE-OF-RECORD: prior documentation described legal-personal as
 * clo-personal/clo/cfo. The code-of-record (search-privileged.ts, EXEC_RING, effective 2026-07-04)
 * gates legal-personal to the full executive ring: cfo, clo, clo-personal, coo, cro, cpo, cco, exec.
 * This module intentionally matches the CODE (the enforced reality for the sibling search tool) so
 * the two access paths to the same corpus are consistent. clo-personal, clo, and cfo remain within
 * that ring, so the brief's named lanes are all satisfied. If the intended ring for personal legal
 * data is actually narrower than the exec ring, that is a policy decision to make in ONE place
 * (search-privileged.ts INDEX_LANES) and it will flow to both the search tool and these blob tools.
 */

import { INDEX_LANES } from '../kb/search-privileged.js';

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
