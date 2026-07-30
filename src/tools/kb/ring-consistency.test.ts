import { test } from 'node:test';
import assert from 'node:assert/strict';
import { INDEX_LANES, EXEC_RING, PERSONAL_LEGAL_RING, OPS_RING, isLaneAllowed } from './search-privileged.js';
import { roomsFor, RING_ROOMS, OPEN_ROOMS } from './brain-search.js';
import { isLegalContainerAllowed, lanesForContainer, type LegalContainer } from '../legal/ring.js';

/**
 * RING-CONFIG CI LINT: the cross-consumer consistency matrix.
 *
 * WHY THIS FILE EXISTS, and why it is separate from the three existing per-consumer test files
 * (search-privileged.test.ts, brain-search.test.ts, legal/ring.test.ts): those files each correctly
 * pin their OWN consumer's behavior against INDEX_LANES, and each of them already independently
 * encodes both real historical incidents (coo/cro over-privilege, the personal-legal P0 leak) as
 * regression fixtures. What none of them proves, individually, is that the three consumers CANNOT
 * DISAGREE WITH EACH OTHER on any given (lane, room) pair -- each file only proves its own consumer
 * agrees with the shared source, not that all three consumers, composed, produce one consistent
 * answer. This file is that missing cross-cutting proof, built as a full (lane x room) matrix rather
 * than a handful of named cases, so a future new lane or new privileged room is covered automatically
 * without anyone remembering to add a new named test.
 *
 * THE CORRECTED UNDERSTANDING THIS FILE IS BUILT ON (2026-07-30 Descope research-pass review, see
 * otchealth-cto/research/2026-07-30-descope-deep-dive/SYNTHESIS.md section 3 and the design-proposal
 * panel): both real incidents were caused by a WRONG VALUE written into the ONE canonical source
 * (INDEX_LANES) itself, not by three independently-maintained lists desynchronizing -- all three
 * consumers already derived from that one source at the time of both incidents, and continue to.
 * A test that only checks "do the derived values agree with the canonical source" is therefore
 * VACUOUSLY SATISFIED when the source itself is wrong -- it would not have caught either incident.
 * What actually catches this class of bug, and what this file is, is an ACCESS-MATRIX / FIXTURE-BASED
 * test asserting specific expected-ALLOW/expected-DENY outcomes per (lane, room) pair, with both
 * historical incidents encoded as permanent regression fixtures that fail the build the instant the
 * bad grant reappears -- regardless of which file holds the wrong value or whether every consumer
 * still agrees on it. The full matrix below is the general form of that same idea: it does not just
 * re-check the two known incidents (that's the dedicated block at the bottom), it checks EVERY
 * (lane, room) pair this fleet currently knows about, so a THIRD, not-yet-imagined incident shaped
 * the same way (a wrong value in INDEX_LANES for a pair nobody thought to name individually) is caught
 * by the same mechanism instead of waiting for a fourth named regression test to be hand-written.
 *
 * WIRED INTO CI: this file matches src/**\/*.test.ts, which .github/workflows/ci.yml's REQUIRED
 * "Test" step (`npm test`) already runs on every PR to main and every push to main -- no new workflow
 * needed. A failure here blocks the merge, exactly like every other test in this repository.
 */

/** Every room INDEX_LANES currently gates -- the full privileged surface, not a hand-picked subset. */
const ALL_PRIVILEGED_ROOMS = Object.keys(INDEX_LANES);

/** Rooms that also have a legal_blob_* container (only the two legal rooms; finance has none). */
const ROOM_TO_LEGAL_CONTAINER: Record<string, LegalContainer> = {
  'legal-company': 'company',
  'legal-personal': 'personal',
};

/**
 * Every lane this fleet is known to provision, both privileged and not. Deliberately a real,
 * concrete list (not "every string") -- the matrix's job is to prove consistency across CURRENTLY
 * KNOWN lanes; a wholly new, not-yet-provisioned lane name has no meaningful "expected" answer to
 * assert against until it exists. Sourced from EXEC_RING + PERSONAL_LEGAL_RING (privileged) plus the
 * same representative non-privileged set the sibling test files already use (search-privileged.test.ts's
 * EXCLUDED_AGENTS), so this file needs no new taxonomy of its own.
 */
const ALL_KNOWN_LANES = [
  ...new Set<string>([
    ...EXEC_RING,
    ...PERSONAL_LEGAL_RING,
    ...OPS_RING,
    'cto',
    'default',
    'developer',
    'coo',
    'cro',
    'commerce',
    'lifecycle',
    'iheartest',
    'innerease',
    'flatstick',
    'fourvault',
    'fictionary',
    'companion',
    'otchealthmart',
    'focus-group',
  ]),
];

// --- structural invariant: the room LISTS themselves cannot drift, before checking any lane ----------

test('STRUCTURAL: brain-search.ts\'s RING_ROOMS is byte-identical (as a set) to Object.keys(INDEX_LANES)', () => {
  // RING_ROOMS is a hand-written literal array in brain-search.ts, independent of INDEX_LANES's own
  // keys -- these are two separately-declared lists that currently happen to describe the same six
  // rooms. If a future privileged room were added to INDEX_LANES but not RING_ROOMS (or vice versa),
  // this is the test that catches the drift directly, rather than relying on it to manifest as a
  // harder-to-diagnose access discrepancy somewhere downstream.
  assert.deepEqual([...RING_ROOMS].sort(), [...ALL_PRIVILEGED_ROOMS].sort());
});

test('STRUCTURAL: legal_blob_*\'s container lanes are DERIVED from INDEX_LANES, not a separate list, for both legal containers', () => {
  for (const [room, container] of Object.entries(ROOM_TO_LEGAL_CONTAINER)) {
    assert.deepEqual(lanesForContainer(container).sort(), [...INDEX_LANES[room]].sort(), `container "${container}" must mirror INDEX_LANES["${room}"] exactly`);
  }
});

test('STRUCTURAL: OPEN_ROOMS and the privileged rooms are disjoint (no room is both open and ring-gated)', () => {
  const open = new Set<string>(OPEN_ROOMS);
  for (const room of ALL_PRIVILEGED_ROOMS) {
    assert.equal(open.has(room), false, `${room} must not also be an OPEN_ROOM`);
  }
});

// --- THE FULL CROSS-CONSUMER MATRIX: every (lane, room) pair, all three consumers must agree ---------

test('THE MATRIX: kb_search_privileged, brain_search, and legal_blob_* agree on EVERY (lane, room) pair', () => {
  let checked = 0;
  for (const room of ALL_PRIVILEGED_ROOMS) {
    for (const lane of ALL_KNOWN_LANES) {
      const viaSearchPrivileged = isLaneAllowed(room, lane);
      const viaBrainSearch = roomsFor(lane).includes(room);
      assert.equal(
        viaBrainSearch,
        viaSearchPrivileged,
        `DISAGREEMENT for lane="${lane}" room="${room}": kb_search_privileged says ${viaSearchPrivileged}, brain_search says ${viaBrainSearch}`,
      );
      const container = ROOM_TO_LEGAL_CONTAINER[room];
      if (container) {
        const viaLegalBlob = isLegalContainerAllowed(container, lane);
        assert.equal(
          viaLegalBlob,
          viaSearchPrivileged,
          `DISAGREEMENT for lane="${lane}" room="${room}" container="${container}": kb_search_privileged says ${viaSearchPrivileged}, legal_blob_* says ${viaLegalBlob}`,
        );
      }
      checked++;
    }
  }
  // Sanity floor so a refactor that accidentally empties either fixture list cannot silently pass
  // this test having checked nothing (a matrix over zero pairs is vacuously true, the exact footgun
  // this whole file exists to avoid reproducing).
  assert.ok(checked >= ALL_PRIVILEGED_ROOMS.length * ALL_KNOWN_LANES.length, 'the matrix must have actually iterated every pair');
  assert.ok(checked > 100, `expected a substantial matrix, only checked ${checked} pairs`);
});

test('THE MATRIX also holds for an absent/unauthenticated caller ("", undefined, null) across every room', () => {
  for (const room of ALL_PRIVILEGED_ROOMS) {
    for (const caller of ['', undefined, null] as const) {
      const viaSearchPrivileged = isLaneAllowed(room, caller);
      const viaBrainSearch = roomsFor(caller).includes(room);
      assert.equal(viaSearchPrivileged, false, `unauthenticated caller must never reach ${room} via kb_search_privileged`);
      assert.equal(viaBrainSearch, false, `unauthenticated caller must never reach ${room} via brain_search`);
      const container = ROOM_TO_LEGAL_CONTAINER[room];
      if (container) {
        assert.equal(isLegalContainerAllowed(container, caller), false, `unauthenticated caller must never reach ${room} via legal_blob_*`);
      }
    }
  }
});

// --- BOTH HISTORICAL INCIDENTS, restated once more here as the consolidated canonical reference -------
// (each is ALSO independently pinned in its own consumer's test file; this block is deliberately
// redundant with those -- it is the single place a future reader can see both incidents proven across
// ALL THREE consumers side by side, in the same file as the general matrix above.)

test('INCIDENT 1 (PR #141, 2026-07-21): coo and cro must be denied on EVERY privileged room, via all three consumers', () => {
  for (const lane of ['coo', 'cro']) {
    for (const room of ALL_PRIVILEGED_ROOMS) {
      assert.equal(isLaneAllowed(room, lane), false, `kb_search_privileged: ${lane} must not reach ${room}`);
      assert.equal(roomsFor(lane).includes(room), false, `brain_search: ${lane} must not reach ${room}`);
      const container = ROOM_TO_LEGAL_CONTAINER[room];
      if (container) {
        assert.equal(isLegalContainerAllowed(container, lane), false, `legal_blob_*: ${lane} must not reach ${room} (container ${container})`);
      }
    }
  }
});

test('INCIDENT 2 (mcp-server #124, 2026-07-16, Option B): the personal-legal rooms are reachable ONLY by clo-personal + exec, via all three consumers -- cfo/clo/cpo/cco denied', () => {
  const personalRooms = ['legal-personal', 'legal-personal-memory'];
  const deniedExecLanes = ['cfo', 'clo', 'cpo', 'cco']; // full EXEC_RING members, STRIPPED from personal-legal
  for (const room of personalRooms) {
    for (const lane of PERSONAL_LEGAL_RING) {
      assert.equal(isLaneAllowed(room, lane), true, `kb_search_privileged: ${lane} must reach ${room}`);
      assert.equal(roomsFor(lane).includes(room), true, `brain_search: ${lane} must reach ${room}`);
    }
    for (const lane of deniedExecLanes) {
      assert.equal(isLaneAllowed(room, lane), false, `kb_search_privileged: ${lane} (the leak) must NOT reach ${room}`);
      assert.equal(roomsFor(lane).includes(room), false, `brain_search: ${lane} (the leak) must NOT reach ${room}`);
    }
  }
  // legal_blob_* only has a container for legal-personal, not legal-personal-memory
  for (const lane of PERSONAL_LEGAL_RING) {
    assert.equal(isLegalContainerAllowed('personal', lane), true, `legal_blob_*: ${lane} must reach the personal container`);
  }
  for (const lane of deniedExecLanes) {
    assert.equal(isLegalContainerAllowed('personal', lane), false, `legal_blob_*: ${lane} (the leak) must NOT reach the personal container`);
  }
});
