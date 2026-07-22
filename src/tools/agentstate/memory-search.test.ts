import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateMemorySearchAccess } from './memory-search.js';

// ---- explicit agent filter: own agent, always allowed ------------------------------------------

test('a caller can always search their own agent, privileged or not', () => {
  assert.deepEqual(evaluateMemorySearchAccess('developer', 'developer'), { allowed: true });
  assert.deepEqual(evaluateMemorySearchAccess('cfo', 'cfo'), { allowed: true });
  assert.deepEqual(evaluateMemorySearchAccess('clo-personal', 'clo-personal'), { allowed: true });
  assert.deepEqual(evaluateMemorySearchAccess('external-read', 'external-read'), { allowed: true });
});

test('agent-name comparison is case-insensitive and trims whitespace', () => {
  assert.equal(evaluateMemorySearchAccess('CFO', ' cfo ').allowed, true);
});

// ---- explicit agent filter: clo-personal (PERSONAL_LEGAL_RING) ---------------------------------

test('clo-personal memory is refused for every caller except clo-personal itself and exec', () => {
  for (const caller of ['cfo', 'clo', 'cpo', 'cco', 'developer', 'external-read', 'cto', 'iheartest', '']) {
    const d = evaluateMemorySearchAccess(caller, 'clo-personal');
    assert.equal(d.allowed, false, `caller "${caller}" must be refused reading clo-personal memory`);
    assert.match(d.reason ?? '', /clo-personal/);
  }
});

test('clo-personal memory is allowed for clo-personal itself and for exec', () => {
  assert.equal(evaluateMemorySearchAccess('clo-personal', 'clo-personal').allowed, true);
  assert.equal(evaluateMemorySearchAccess('exec', 'clo-personal').allowed, true);
});

// ---- explicit agent filter: other EXEC_RING agents (cfo/clo/cpo/cco/exec) ----------------------

test('another EXEC_RING agent\'s memory requires an EXEC_RING caller (cross-team visibility), never a non-exec one', () => {
  for (const requested of ['cfo', 'clo', 'cpo', 'cco', 'exec']) {
    for (const caller of ['developer', 'external-read', 'cto', 'iheartest', '']) {
      const d = evaluateMemorySearchAccess(caller, requested);
      assert.equal(d.allowed, false, `non-exec caller "${caller}" must be refused reading "${requested}" memory`);
    }
    // any OTHER exec-ring member may cross-read it (mirrors the existing exec-team-visibility model)
    for (const caller of ['cfo', 'clo', 'cpo', 'cco', 'exec']) {
      if (caller === requested) continue; // already covered by the "own agent" test above
      assert.equal(evaluateMemorySearchAccess(caller, requested).allowed, true, `exec-ring caller "${caller}" must be allowed to read "${requested}" memory`);
    }
  }
});

// ---- explicit agent filter: a non-privileged agent ----------------------------------------------

test('a non-privileged agent\'s memory stays open to any caller, unchanged from prior behavior', () => {
  for (const caller of ['developer', 'external-read', 'cto', '', 'iheartest', 'growth']) {
    assert.deepEqual(evaluateMemorySearchAccess(caller, 'developer'), { allowed: true });
  }
});

// ---- omitted agent filter (global/cross-agent search) -------------------------------------------

test('omitting the agent filter with NO caller identity at all is refused outright (never an unscoped scan)', () => {
  const d = evaluateMemorySearchAccess('', undefined);
  assert.equal(d.allowed, false);
  assert.match(d.reason ?? '', /no caller identity/);
  const d2 = evaluateMemorySearchAccess(null, null);
  assert.equal(d2.allowed, false);
});

test('omitting the agent filter for a NON-exec caller force-scopes the search to their own agent (never a global scan)', () => {
  for (const caller of ['developer', 'external-read', 'cto', 'iheartest']) {
    const d = evaluateMemorySearchAccess(caller, undefined);
    assert.equal(d.allowed, true);
    assert.equal(d.forcedAgent, caller);
    assert.equal(d.excludeClopersonalFromGlobal, undefined);
  }
});

test('omitting the agent filter for an EXEC_RING caller (not clo-personal/exec) allows the global search but flags clo-personal for exclusion', () => {
  for (const caller of ['cfo', 'clo', 'cpo', 'cco']) {
    const d = evaluateMemorySearchAccess(caller, undefined);
    assert.equal(d.allowed, true);
    assert.equal(d.forcedAgent, undefined, `caller "${caller}" should not be forced to a single agent`);
    assert.equal(d.excludeClopersonalFromGlobal, true, `caller "${caller}"'s global search must exclude clo-personal`);
  }
});

test('omitting the agent filter for clo-personal or exec allows the global search WITHOUT excluding clo-personal', () => {
  for (const caller of ['clo-personal', 'exec']) {
    const d = evaluateMemorySearchAccess(caller, undefined);
    assert.equal(d.allowed, true);
    assert.equal(d.forcedAgent, undefined);
    assert.equal(d.excludeClopersonalFromGlobal, false);
  }
});

// ---- regression pin: the exact leak this fix closes ----------------------------------------------

test('REGRESSION: an external-read caller can no longer name a privileged agent and read its memory', () => {
  // This is the exact exploit shape: memory_search is on EXTERNAL_READONLY_TOOLSET, and before this
  // fix, an external-read caller passing agent:'clo-personal' (or any other EXEC_RING agent) got
  // every raw Cosmos record for that agent back with zero authorization check.
  assert.equal(evaluateMemorySearchAccess('external-read', 'clo-personal').allowed, false);
  assert.equal(evaluateMemorySearchAccess('external-read', 'cfo').allowed, false);
  assert.equal(evaluateMemorySearchAccess('external-read', 'exec').allowed, false);
});

test('REGRESSION: an external-read caller omitting the agent filter no longer gets an unscoped cross-agent scan', () => {
  const d = evaluateMemorySearchAccess('external-read', undefined);
  assert.equal(d.forcedAgent, 'external-read', 'must be forced to its own partition, never a global scan across every agent');
});
