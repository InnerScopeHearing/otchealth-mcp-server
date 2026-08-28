import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { memoryWriteRefusal, memoryWriteIdentityRefusal, handleMemoryWrite } from './memory-write.js';
import { EXEC_RING } from '../kb/search-privileged.js';
import { requestContext } from '../../server/request-context.js';

// Only needed by the handler-level tests below (the pure-function tests above never call
// loadEnv()): handleMemoryWrite's dry_run/not-configured branches call isConfigured() ->
// loadEnv(), which throws on missing required vars. Same minimal preamble as the other test files.
before(() => {
  const required: Record<string, string> = {
    CIO_SITE_ID: 'test',
    CIO_TRACK_KEY: 'test',
    CIO_APP_API_BEARER: 'test',
    PERPLEXITY_CONNECTOR_TOKEN: 'x'.repeat(32),
    ADMIN_REVOKE_TOKEN: 'x'.repeat(32),
    N8N_WEBHOOK_SECRET: 'x'.repeat(32),
    // isConfigured() is checked BEFORE ctx.dryRun in handleMemoryWrite -- without these, every
    // handler-level test below would stop at "Cosmos not configured" rather than exercising the
    // gate/branch each test actually targets. STATE_BACKEND pinned to 'cosmos' (2026-08-28): its
    // schema default flipped to 'postgres' the same day, and this file predates that flip.
    STATE_BACKEND: 'cosmos',
    COSMOS_ENDPOINT: 'https://test.documents.azure.com',
    COSMOS_DB: 'test',
    COSMOS_KEY: Buffer.from('test-key').toString('base64'),
  };
  for (const [k, v] of Object.entries(required)) process.env[k] ??= v;
});

// Layer 3 (defense-in-depth) of the Phase 5/6 connector-ring closure (2026-07-15): before this,
// memory_write's handler wrote ANY input.agent namespace with ZERO caller authorization -- a
// connector-surface caller of any lane (or none at all) could write to the durable fleet
// memory-of-record. Layers 1 (registry.ts's per-lane connector toolset) and 2 (oauth.ts's DCR
// default lane) already keep an unauthorized connector from ever SEEING or being HANDED memory_write
// in the normal flow, but this handler-level gate is the last line: it refuses the call outright,
// fail-CLOSED, independent of how the caller reached the handler. Hermetic (no Cosmos, no network) --
// memoryWriteRefusal is a pure function of (connectorSurface, lane), mirroring isLaneAllowed() /
// isLegalContainerAllowed()'s "mock the two upstream signals as plain arguments" pattern.

test('SAFETY-CRITICAL: an external-read connector-surface caller is refused', () => {
  const refusal = memoryWriteRefusal(true, 'external-read');
  assert.ok(refusal, 'external-read must be refused on the connector surface');
  assert.match(refusal!, /not authorized to write fleet memory/);
});

test('a cto connector-surface caller is allowed (no refusal)', () => {
  assert.equal(memoryWriteRefusal(true, 'cto'), null);
});

test('a developer connector-surface caller is allowed', () => {
  assert.equal(memoryWriteRefusal(true, 'developer'), null);
});

test('every EXEC_RING lane EXCEPT clo-personal is allowed to write memory over a connector surface', () => {
  // clo-personal IS a member of EXEC_RING (search-privileged.ts:81 -- it is the personal-legal ring's
  // own lane, PERSONAL_LEGAL_RING = ['clo-personal','exec']), but memory_write is a BROADCAST surface
  // (write-through indexed into memory-exec, read by every lane's brain_search), so it gets its own
  // unconditional carve-out below regardless of its EXEC_RING membership -- see the clo-personal test.
  for (const lane of EXEC_RING) {
    if (lane === 'clo-personal') continue;
    assert.equal(memoryWriteRefusal(true, lane), null, `${lane} should be allowed to write memory`);
  }
});

test('SAFETY-CRITICAL: an empty/unknown connector-surface lane is refused', () => {
  assert.ok(memoryWriteRefusal(true, ''));
  assert.ok(memoryWriteRefusal(true, 'randostring'));
});

test('non-connector-surface callers are NEVER refused by this gate (client_credentials / static token unaffected), EXCEPT clo-personal', () => {
  assert.equal(memoryWriteRefusal(false, 'external-read'), null);
  assert.equal(memoryWriteRefusal(false, ''), null);
  assert.equal(memoryWriteRefusal(false, 'randostring'), null);
  assert.equal(memoryWriteRefusal(false, 'cto'), null);
});

// Found + fixed 2026-07-30, alongside the identity-forgery gate below: memory_write's own docstring
// has always claimed "non-privileged (clo-personal rejected)", but nothing in the code enforced it --
// agents.ts's shared normalizeAgent() FORBIDDEN_AGENTS set is empty (by design; it is shared by every
// read/write path, including clo-personal's own legitimate self-reads elsewhere, so populating it
// there would break clo-personal's normal operation, not just this one tool). A clo-personal-
// authenticated caller writing under its OWN true identity would otherwise leak privileged
// personal-legal content onto memory-exec, a room every lane's brain_search reaches -- distinct from
// (and in addition to) the identity-forgery bug below, since here the caller's identity claim is
// entirely genuine, the room it lands in is simply the wrong one for that identity.
test('SAFETY-CRITICAL: clo-personal is refused UNCONDITIONALLY, connector surface or not', () => {
  const connectorRefusal = memoryWriteRefusal(true, 'clo-personal');
  assert.ok(connectorRefusal, 'clo-personal must be refused on the connector surface');
  assert.match(connectorRefusal!, /clo-personal/);
  assert.match(connectorRefusal!, /privilege-walled/);

  const directRefusal = memoryWriteRefusal(false, 'clo-personal');
  assert.ok(directRefusal, 'clo-personal must be refused even as a direct client_credentials caller');
  assert.match(directRefusal!, /clo-personal/);
});

test('clo-personal casing/whitespace variants are still caught', () => {
  assert.ok(memoryWriteRefusal(false, 'CLO-PERSONAL'));
  assert.ok(memoryWriteRefusal(false, '  clo-personal  '));
});

// IDENTITY-FORGERY GATE (found + fixed 2026-07-30): before this, the handler wrote input.agent
// verbatim as the record's attribution with ZERO check against the caller's own authenticated
// identity -- any caller reachable to memory_write could attribute a forged, byte-exact,
// broadly-recallable "system-of-record" entry to any OTHER lane (e.g. a low-privilege lane writing
// {agent:"cto", kind:"decision", text:"..."} to inject a fake decision every agent would trust as
// genuine on its next wake()/brain_search). memoryWriteIdentityRefusal is the fix: memory_write is
// self-write-only (unlike memory_remember's real cross-lane feature), so a requested `agent` that
// does not match the caller's authenticated identity is refused outright.

test('SAFETY-CRITICAL: a matching agent is allowed (self-write, the only legitimate case)', () => {
  assert.equal(memoryWriteIdentityRefusal('cto', 'cto'), null);
  assert.equal(memoryWriteIdentityRefusal('commerce', 'commerce'), null);
});

test('SAFETY-CRITICAL: a case/whitespace-only difference is still treated as a match', () => {
  assert.equal(memoryWriteIdentityRefusal('cto', 'CTO'), null);
  assert.equal(memoryWriteIdentityRefusal('cto', '  cto  '), null);
});

test('SAFETY-CRITICAL: this is the exact forgery this gate exists to stop -- a low-privilege caller cannot attribute a write to a DIFFERENT, more-trusted lane', () => {
  const refusal = memoryWriteIdentityRefusal('commerce', 'cto');
  assert.ok(refusal, 'commerce claiming to write as cto must be refused');
  assert.match(refusal!, /commerce/);
  assert.match(refusal!, /cto/);
});

test('SAFETY-CRITICAL: forgery is refused symmetrically, not just "up" toward a privileged lane', () => {
  const refusal = memoryWriteIdentityRefusal('cto', 'commerce');
  assert.ok(refusal, 'cto claiming to write as commerce must ALSO be refused -- this is an identity check, not a privilege check');
});

test('SAFETY-CRITICAL: no verifiable caller identity is refused outright, even with no requested agent to compare', () => {
  assert.ok(memoryWriteIdentityRefusal('', ''));
  assert.ok(memoryWriteIdentityRefusal('', 'cto'));
});

test('an empty/omitted requested agent is allowed when the caller has a real identity (defaults to self)', () => {
  assert.equal(memoryWriteIdentityRefusal('cto', ''), null);
});

// REGRESSION (2026-07-30 review): the handler builds every summary as `Refused: ${reason}`. Before
// this, both memoryWriteRefusal and memoryWriteIdentityRefusal's own return strings ALSO started
// with a lowercase "refused: ", producing a doubled "Refused: refused: ..." in every rejection
// summary. Fixed by having these two functions return a bare, self-contained explanation with no
// "refused"/"Refused" framing of their own -- the ONE "Refused:" prefix lives at the call site.
// Locked here so neither function can silently regress back to self-prefixing.
test('REGRESSION: no refusal reason string starts with "refused" (the call site owns that prefix, exactly once)', () => {
  const refusalReasons = [
    memoryWriteRefusal(true, 'external-read'),
    memoryWriteRefusal(true, ''),
    memoryWriteRefusal(true, 'clo-personal'),
    memoryWriteRefusal(false, 'clo-personal'),
    memoryWriteIdentityRefusal('', ''),
    memoryWriteIdentityRefusal('', 'cto'),
    memoryWriteIdentityRefusal('commerce', 'cto'),
  ];
  for (const reason of refusalReasons) {
    assert.ok(reason, 'expected a non-null refusal reason for this fixture');
    assert.doesNotMatch(reason!.trim(), /^refused[:\s]/i, `reason must not self-prefix with "refused": "${reason}"`);
  }
});

// REGRESSION (2026-07-30 review): memoryWriteRefusal's clo-personal branch fires UNCONDITIONALLY,
// including for a NON-connector-surface caller, so the reason string itself must never assume or
// name "connector surface" -- only the OTHER branch (a non-ship-lane connector caller) is actually
// about the connector surface specifically.
test('REGRESSION: the clo-personal refusal reason never mentions "connector" (it fires unconditionally, not just there)', () => {
  const connectorReason = memoryWriteRefusal(true, 'clo-personal');
  const directReason = memoryWriteRefusal(false, 'clo-personal');
  assert.ok(connectorReason);
  assert.ok(directReason);
  assert.doesNotMatch(connectorReason!, /connector/i);
  assert.doesNotMatch(directReason!, /connector/i);
  assert.equal(connectorReason, directReason, 'the reason is identical regardless of connector surface -- it is an unconditional block');
});

// -------------------------------------------------------------------------------------------
// handleMemoryWrite -- handler-level tests through the ACTUAL registered entry point (Copilot
// review, 2026-07-30: "the new safety-critical tests exercise only the pure helper, so they still
// pass if the registered memory_write handler stops calling this gate or accidentally persists
// input.agent again... That is the actual exploit path this PR is intended to close").
//
// currentCallerAgent() reads from requestContext (AsyncLocalStorage), NOT from ctx.callerAgent --
// exactly how the real server resolves identity (see server/mcp.ts) -- so every test below wraps
// the call in requestContext.run() to simulate an authenticated caller. All three scenarios here
// are refusal paths that return BEFORE isConfigured()/writeMemory()/embed() are ever reached (see
// handleMemoryWrite's own code order), so no Cosmos/Azure OpenAI mocking is needed: the assertion
// that the returned `note` is SPECIFICALLY the identity-mismatch (or clo-personal, or no-identity)
// reason -- not e.g. "Cosmos not configured" -- is itself the proof the call stopped at THIS gate,
// not merely failed for an unrelated downstream reason.
// -------------------------------------------------------------------------------------------

function fakeCtx(dryRun = false) {
  return { correlationId: 'test-corr', callerHash: 'test-hash', dryRun, acknowledgeWarning: false, callerAgent: '' };
}

test('SAFETY-CRITICAL (handler-level): a forged agent is refused BEFORE any storage attempt -- written:false, the identity-mismatch reason, no record', async () => {
  const result = await requestContext.run(
    { callerAgent: 'commerce', callerHash: 'h', correlationId: 'c' },
    () => handleMemoryWrite({ agent: 'cto', kind: 'fact', text: 'a forged decision' }, fakeCtx()),
  );
  const data = result.data as { written: boolean; note?: string; record?: unknown };
  assert.equal(data.written, false);
  assert.match(data.note ?? '', /authenticated identity is "commerce"/);
  assert.match(data.note ?? '', /requested agent "cto"/);
  assert.equal(data.record, undefined, 'no record was ever built or persisted');
});

test('SAFETY-CRITICAL (handler-level): clo-personal is refused even on a genuine SELF-write (agent matches caller)', async () => {
  const result = await requestContext.run(
    { callerAgent: 'clo-personal', callerHash: 'h', correlationId: 'c' },
    () => handleMemoryWrite({ agent: 'clo-personal', kind: 'fact', text: 'a personal-legal note' }, fakeCtx()),
  );
  const data = result.data as { written: boolean; note?: string };
  assert.equal(data.written, false);
  assert.match(data.note ?? '', /privilege-walled personal-legal lane/);
});

test('SAFETY-CRITICAL (handler-level): no authenticated identity at all (empty requestContext) is refused, not defaulted', async () => {
  const result = await requestContext.run(
    { callerAgent: '', callerHash: 'h', correlationId: 'c' },
    () => handleMemoryWrite({ agent: 'cto', kind: 'fact', text: 'attributed to nobody' }, fakeCtx()),
  );
  const data = result.data as { written: boolean; note?: string };
  assert.equal(data.written, false);
  assert.match(data.note ?? '', /no verifiable agent identity/);
});

test('handler-level: a matching self-write clears BOTH refusal gates -- reaches the dry_run preview (not a Cosmos "unconfigured" or identity-mismatch note)', async () => {
  // dry_run:true short-circuits BEFORE isConfigured()/writeMemory() too, so this stays hermetic
  // while proving the call gets PAST both refusal gates for the one legitimate case (self-write).
  const result = await requestContext.run(
    { callerAgent: 'cto', callerHash: 'h', correlationId: 'c' },
    () => handleMemoryWrite({ agent: 'cto', kind: 'fact', text: 'a genuine self-write' }, fakeCtx(true)),
  );
  const data = result.data as { written: boolean; note?: string; preview?: { agent?: string } };
  assert.equal(data.written, false); // dry_run never persists
  assert.equal(data.note, 'dry_run: pass dry_run=false to persist.', 'must reach the dry_run branch, not an earlier refusal');
  assert.equal(data.preview?.agent, 'cto', 'the preview is attributed to the authenticated caller');
});
