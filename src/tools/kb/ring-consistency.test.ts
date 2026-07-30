import { test } from 'node:test';
import assert from 'node:assert/strict';
import { INDEX_LANES, EXEC_RING, PERSONAL_LEGAL_RING, isLaneAllowed } from './search-privileged.js';
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
 *
 * ROUND-2 SELF-CORRECTION (2026-07-30, caught by a Copilot PR review, confirmed and fixed): the FIRST
 * version of "THE MATRIX" test below committed exactly the mistake the paragraph above warns about --
 * it compared `isLaneAllowed()`, `roomsFor()`, and `isLegalContainerAllowed()` against EACH OTHER,
 * with no independent expectation of its own. `isLaneAllowed()` reads INDEX_LANES; `roomsFor()` calls
 * `isLaneAllowed()` directly; the legal helper derives from INDEX_LANES too -- so all three were
 * mechanically guaranteed to agree with each other regardless of what value INDEX_LANES actually
 * held. An accidental grant written into INDEX_LANES would have made every consumer agree on the
 * WRONG answer, and the matrix would still have passed. Fixed below: `EXPECTED_ALLOWED` is a literal,
 * hand-maintained fixture -- it does NOT import or reference INDEX_LANES, EXEC_RING, or
 * PERSONAL_LEGAL_RING -- and every consumer is checked against THAT independent fixture, not against
 * each other. A separate, clearly-labeled STRUCTURAL test below confirms the fixture and the real
 * ring constants currently agree (so a deliberate, reviewed ring change updates both), but that
 * agreement is never used as the source of the matrix's own expectations.
 *
 * WIRED INTO CI: this file matches src/**\/*.test.ts, which .github/workflows/ci.yml's REQUIRED
 * "Test" step (`npm test`) already runs on every PR to main and every push to main -- no new workflow
 * needed. A failure here blocks the merge, exactly like every other test in this repository.
 */

/** Every room INDEX_LANES currently gates -- the full privileged surface, not a hand-picked subset.
 * (Used only to decide WHICH ROOMS to iterate; the ALLOW/DENY answer for each one comes from the
 * independent EXPECTED_ALLOWED fixture below, never from INDEX_LANES itself.) */
const ALL_PRIVILEGED_ROOMS = Object.keys(INDEX_LANES);

/** Rooms that also have a legal_blob_* container (only the two legal rooms; finance has none). */
const ROOM_TO_LEGAL_CONTAINER: Record<string, LegalContainer> = {
  'legal-company': 'company',
  'legal-personal': 'personal',
};

/**
 * THE INDEPENDENT ACCESS FIXTURE. Deliberately literal, hand-typed lane lists -- this is the whole
 * point of the round-2 fix above: these arrays must NOT be spread from EXEC_RING or
 * PERSONAL_LEGAL_RING (see search-privileged.ts), or the matrix below degrades back into "does every
 * consumer agree with itself," which is vacuously true regardless of whether the underlying grant is
 * correct. If a future, deliberate ring change needs these updated, that is a real, visible line-item
 * in the diff -- exactly the friction this file exists to add.
 */
const PRIVILEGED_LANES = ['cfo', 'clo', 'clo-personal', 'cpo', 'cco', 'exec'];
const PERSONAL_LEGAL_LANES = ['clo-personal', 'exec'];

const EXPECTED_ALLOWED: Record<string, readonly string[]> = {
  'finance-cfo-source-docs': PRIVILEGED_LANES,
  'finance-otchealth-cfo-source-docs': PRIVILEGED_LANES,
  'finance-cfo-memory': PRIVILEGED_LANES,
  'legal-company': PRIVILEGED_LANES,
  'legal-personal': PERSONAL_LEGAL_LANES,
  'legal-personal-memory': PERSONAL_LEGAL_LANES,
};

/**
 * Every lane this fleet is known to provision, both privileged and not. A literal, concrete list
 * (not "every string," and not spread from any production ring constant -- see the fixture note
 * above) -- the matrix's job is to prove every consumer matches the fixture across CURRENTLY KNOWN
 * lanes; a wholly new, not-yet-provisioned lane name has no meaningful "expected" answer to assert
 * against until it exists.
 */
const ALL_KNOWN_LANES = [
  ...PRIVILEGED_LANES, // clo-personal/exec are also in PERSONAL_LEGAL_LANES -- a deliberate, sourced overlap, not a duplicate concern
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
];

// --- structural invariants: the room/lane LISTS themselves cannot drift, before checking any pair -----

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

test('STRUCTURAL: the independent EXPECTED_ALLOWED fixture currently agrees with the real EXEC_RING/PERSONAL_LEGAL_RING constants', () => {
  // This is the ONLY place this file lets the real ring constants and the independent fixture touch.
  // It proves the fixture is not stale/wrong TODAY -- it is explicitly NOT used to derive the
  // matrix's own expectations above (that would reintroduce the exact vacuous-agreement bug this file
  // was rewritten to avoid). A deliberate future ring change is expected to require updating BOTH
  // EXEC_RING/PERSONAL_LEGAL_RING (production) and PRIVILEGED_LANES/PERSONAL_LEGAL_LANES (this file's
  // fixture) in the same diff; this test just makes that expectation visible and enforced.
  assert.deepEqual([...PRIVILEGED_LANES].sort(), [...EXEC_RING].sort());
  assert.deepEqual([...PERSONAL_LEGAL_LANES].sort(), [...PERSONAL_LEGAL_RING].sort());
});

// --- THE FULL CROSS-CONSUMER MATRIX: every (lane, room) pair, every consumer must match the ------------
// --- INDEPENDENT fixture (never each other) --------------------------------------------------------

test('THE MATRIX: kb_search_privileged, brain_search, and legal_blob_* each match the independent EXPECTED_ALLOWED fixture on EVERY (lane, room) pair', () => {
  let checked = 0;
  for (const room of ALL_PRIVILEGED_ROOMS) {
    const allowedSet = new Set(EXPECTED_ALLOWED[room] ?? []);
    assert.ok(
      (EXPECTED_ALLOWED[room] ?? []).length > 0,
      `EXPECTED_ALLOWED is missing a fixture entry for room "${room}" -- every privileged room must have an explicit, reviewed expected-allow list`,
    );
    for (const lane of ALL_KNOWN_LANES) {
      const expected = allowedSet.has(lane);
      assert.equal(
        isLaneAllowed(room, lane),
        expected,
        `kb_search_privileged: lane="${lane}" room="${room}" expected allowed=${expected}, per the independent fixture`,
      );
      assert.equal(
        roomsFor(lane).includes(room),
        expected,
        `brain_search: lane="${lane}" room="${room}" expected allowed=${expected}, per the independent fixture`,
      );
      const container = ROOM_TO_LEGAL_CONTAINER[room];
      if (container) {
        assert.equal(
          isLegalContainerAllowed(container, lane),
          expected,
          `legal_blob_*: lane="${lane}" room="${room}" container="${container}" expected allowed=${expected}, per the independent fixture`,
        );
      }
      checked++;
    }
  }
  // Sanity floor so a refactor that accidentally empties either fixture list cannot silently pass
  // this test having checked nothing (a matrix over zero pairs is vacuously true, the exact footgun
  // this whole file exists to avoid reproducing).
  assert.ok(checked === ALL_PRIVILEGED_ROOMS.length * ALL_KNOWN_LANES.length, 'the matrix must have actually iterated every pair, exactly once each');
  assert.ok(checked > 100, `expected a substantial matrix, only checked ${checked} pairs`);
});

test('THE MATRIX also holds for an absent/unauthenticated caller ("", undefined, null) across every room', () => {
  for (const room of ALL_PRIVILEGED_ROOMS) {
    for (const caller of ['', undefined, null] as const) {
      assert.equal(isLaneAllowed(room, caller), false, `unauthenticated caller must never reach ${room} via kb_search_privileged`);
      assert.equal(roomsFor(caller).includes(room), false, `unauthenticated caller must never reach ${room} via brain_search`);
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
// ALL THREE consumers side by side, in the same file as the general matrix above. Uses the same
// literal, independent fixtures as the matrix above -- NOT PERSONAL_LEGAL_RING or EXEC_RING directly
// -- for the identical reason: an "allowed" loop that iterates a live ring constant would silently
// validate a future accidental widening of that same constant as correct.)

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
  const deniedExecLanes = ['cfo', 'clo', 'cpo', 'cco']; // full privileged-lane members, STRIPPED from personal-legal
  for (const room of personalRooms) {
    for (const lane of PERSONAL_LEGAL_LANES) {
      assert.equal(isLaneAllowed(room, lane), true, `kb_search_privileged: ${lane} must reach ${room}`);
      assert.equal(roomsFor(lane).includes(room), true, `brain_search: ${lane} must reach ${room}`);
    }
    for (const lane of deniedExecLanes) {
      assert.equal(isLaneAllowed(room, lane), false, `kb_search_privileged: ${lane} (the leak) must NOT reach ${room}`);
      assert.equal(roomsFor(lane).includes(room), false, `brain_search: ${lane} (the leak) must NOT reach ${room}`);
    }
  }
  // legal_blob_* only has a container for legal-personal, not legal-personal-memory
  for (const lane of PERSONAL_LEGAL_LANES) {
    assert.equal(isLegalContainerAllowed('personal', lane), true, `legal_blob_*: ${lane} must reach the personal container`);
  }
  for (const lane of deniedExecLanes) {
    assert.equal(isLegalContainerAllowed('personal', lane), false, `legal_blob_*: ${lane} (the leak) must NOT reach the personal container`);
  }
});
