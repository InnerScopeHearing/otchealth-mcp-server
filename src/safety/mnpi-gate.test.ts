import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EXEC_RING_ROOM_MARKERS,
  MNPI_MARKER_REGEX,
  INTERNAL_EMAIL_DOMAINS,
  scanTextForMnpi,
  scanFieldsForMnpi,
  isInternalEmailAddress,
  hasExternalRecipient,
  evaluateBroadcastMnpiGate,
  evaluateEmailMnpiGate,
} from './mnpi-gate.js';

// ---- scanTextForMnpi / scanFieldsForMnpi ---------------------------------------------------------

test('scanTextForMnpi: clean business text does not match', () => {
  assert.equal(scanTextForMnpi('The paywall ships Tuesday, no blockers.').matched, false);
});

test('scanTextForMnpi: mentioning the company or its ticker alone does NOT match (avoid false positives)', () => {
  assert.equal(scanTextForMnpi('INND filed its quarterly update today.').matched, false);
  assert.equal(scanTextForMnpi('OTCHealth and InnerScope share a brain.').matched, false);
});

test('scanTextForMnpi: every EXEC_RING room marker is detected, case-insensitively', () => {
  for (const marker of EXEC_RING_ROOM_MARKERS) {
    const hit = scanTextForMnpi(`per ${marker.toUpperCase()} the number is X`);
    assert.equal(hit.matched, true, `${marker} should be detected`);
    assert.equal(hit.marker, marker);
  }
});

test('scanTextForMnpi: the explicit MNPI marker forms are detected', () => {
  assert.equal(scanTextForMnpi('[MNPI] burn rate is X').matched, true);
  assert.equal(scanTextForMnpi('this is MNPI-restricted').matched, true);
  assert.equal(scanTextForMnpi('flagged as MNPI').matched, true);
  assert.equal(scanTextForMnpi('this is material non-public information').matched, true);
  assert.equal(scanTextForMnpi('this is material nonpublic information').matched, true);
});

test('MNPI_MARKER_REGEX: does not match ordinary words containing the substring "material" without the marker phrase', () => {
  assert.equal(MNPI_MARKER_REGEX.test('this is a materially important decision'), false);
});

test('scanFieldsForMnpi: scans every string field and reports which one matched', () => {
  const hit = scanFieldsForMnpi({ subject: 'Q3 update', body: 'see finance-cfo-memory for the burn rate' });
  assert.equal(hit.matched, true);
  assert.equal(hit.field, 'body');
  assert.equal(hit.marker, 'finance-cfo-memory');
});

test('scanFieldsForMnpi: ignores non-string / undefined / null / empty fields without throwing', () => {
  const hit = scanFieldsForMnpi({ a: undefined, b: null, c: '', d: 'clean text' });
  assert.equal(hit.matched, false);
});

test('scanFieldsForMnpi: FAILS CLOSED by throwing when given a non-object (caller bug), proving the fail-closed contract is real code, not decorative', () => {
  assert.throws(() => scanFieldsForMnpi(null as unknown as Record<string, string>));
});

// ---- email recipient helpers ----------------------------------------------------------------------

test('isInternalEmailAddress: recognizes all three internal domains and subdomains', () => {
  assert.equal(isInternalEmailAddress('matt@otchealth.app'), true);
  assert.equal(isInternalEmailAddress('matt@otchealthmart.com'), true);
  assert.equal(isInternalEmailAddress('matt@innd.com'), true);
  assert.equal(isInternalEmailAddress('someone@mail.innd.com'), true, 'subdomains of an internal domain are internal');
});

test('isInternalEmailAddress: an external domain, or a malformed address, is not internal', () => {
  assert.equal(isInternalEmailAddress('someone@gmail.com'), false);
  assert.equal(isInternalEmailAddress('not-an-email'), false);
  assert.equal(isInternalEmailAddress(''), false);
});

test('hasExternalRecipient: true when any address in the list is external, false when all are internal', () => {
  assert.equal(hasExternalRecipient('matt@otchealth.app, counsel@gmail.com'), true);
  assert.equal(hasExternalRecipient('matt@otchealth.app, ops@innd.com'), false);
  assert.equal(hasExternalRecipient(''), false, 'an empty recipient string has no external recipient');
});

// ---- evaluateBroadcastMnpiGate (web_search / memory_remember / memory_write / checkpoint) ---------

test('evaluateBroadcastMnpiGate: clean content is allowed (unaffected legitimate use)', () => {
  const out = evaluateBroadcastMnpiGate({ query: 'what is the going rate for a golf handicap app subscription' });
  assert.equal(out.blocked, false);
  assert.equal(out.tier, 'clear');
});

test('evaluateBroadcastMnpiGate: EXEC_RING room reference is a HARD BLOCK regardless of caller (no caller param exists on this gate at all)', () => {
  const out = evaluateBroadcastMnpiGate({ text: 'summarized from legal-personal: the filing date is X' });
  assert.equal(out.blocked, true);
  assert.equal(out.tier, 'hard_block');
  assert.match(out.reason, /HARD BLOCK/);
});

test('evaluateBroadcastMnpiGate: an explicit MNPI marker is a HARD BLOCK', () => {
  const out = evaluateBroadcastMnpiGate({ summary: '[MNPI] the acquisition closes next week' });
  assert.equal(out.blocked, true);
  assert.equal(out.tier, 'hard_block');
});

test('evaluateBroadcastMnpiGate: FAILS CLOSED on an internal error (malformed input) instead of allowing', () => {
  const out = evaluateBroadcastMnpiGate(null as unknown as Record<string, string>);
  assert.equal(out.blocked, true);
  assert.equal(out.tier, 'hard_block');
  assert.match(out.reason, /failed CLOSED/);
});

test('evaluateBroadcastMnpiGate: multiple fields, only one flagged, still blocks (scan checks every field)', () => {
  const out = evaluateBroadcastMnpiGate({ tags: 'golf,pricing', text: 'nothing sensitive here', source: 'ref finance-cfo-source-docs row 12' });
  assert.equal(out.blocked, true);
  assert.equal(out.tier, 'hard_block');
  assert.match(out.reason, /finance-cfo-source-docs/);
});

// ---- evaluateEmailMnpiGate (graph_send_email) ------------------------------------------------------

test('evaluateEmailMnpiGate: clean content to an external recipient is allowed (ordinary business email unaffected)', () => {
  const out = evaluateEmailMnpiGate(
    { subject: 'Thanks for your order', body: 'Your Flatstick receipt is attached.' },
    'customer@gmail.com',
    'cto',
  );
  assert.equal(out.blocked, false);
  assert.equal(out.tier, 'clear');
});

test('evaluateEmailMnpiGate: matched content + external recipient is a HARD BLOCK even for an EXEC_RING caller', () => {
  const out = evaluateEmailMnpiGate(
    { subject: 'Q3 numbers', body: 'per finance-cfo-memory, revenue is $X before the public filing' },
    'counsel@gmail.com',
    'exec',
  );
  assert.equal(out.blocked, true);
  assert.equal(out.tier, 'hard_block');
  assert.match(out.reason, /HARD BLOCK/);
});

test('evaluateEmailMnpiGate: matched content + ALL internal recipients + EXEC_RING caller is allowed', () => {
  const out = evaluateEmailMnpiGate(
    { body: 'per finance-cfo-memory, revenue is on track' },
    'cfo@otchealth.app, exec@otchealth.app',
    'exec',
  );
  assert.equal(out.blocked, false);
  assert.equal(out.tier, 'clear');
});

test('evaluateEmailMnpiGate: matched content + all internal recipients + NON-exec caller is blocked (exec_ring_required)', () => {
  const out = evaluateEmailMnpiGate(
    { body: 'per finance-cfo-memory, revenue is on track' },
    'ops@otchealth.app',
    'cto',
  );
  assert.equal(out.blocked, true);
  assert.equal(out.tier, 'exec_ring_required');
});

test('evaluateEmailMnpiGate: matched content + all internal recipients + no caller identity at all is blocked', () => {
  const out = evaluateEmailMnpiGate({ body: 'material non-public information about the raise' }, 'ops@otchealth.app', undefined);
  assert.equal(out.blocked, true);
  assert.equal(out.tier, 'exec_ring_required');
});

test('evaluateEmailMnpiGate: no content match is allowed for a non-exec caller too (the gate only engages on a detected signal)', () => {
  const out = evaluateEmailMnpiGate({ subject: 'Standup notes', body: 'nothing sensitive' }, 'team@otchealth.app', 'developer');
  assert.equal(out.blocked, false);
});

test('evaluateEmailMnpiGate: FAILS CLOSED on an internal error (malformed fields) instead of allowing', () => {
  const out = evaluateEmailMnpiGate(null as unknown as Record<string, string>, 'anyone@gmail.com', 'exec');
  assert.equal(out.blocked, true);
  assert.equal(out.tier, 'hard_block');
  assert.match(out.reason, /failed CLOSED/);
});

test('sanity: INTERNAL_EMAIL_DOMAINS is exactly the three expected company domains (regression pin)', () => {
  assert.deepEqual([...INTERNAL_EMAIL_DOMAINS].sort(), ['innd.com', 'otchealth.app', 'otchealthmart.com']);
});
