import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseColdStartMode,
  computeColdStartOutcome,
  markWoken,
  evaluateColdStart,
  __resetColdStartState,
  COLD_START_MESSAGE,
  WAKE_TTL_MS,
} from './cold-start.js';

// ---- parseColdStartMode -------------------------------------------------------------------------

test('parseColdStartMode: valid modes pass through, case-insensitive and trimmed', () => {
  assert.equal(parseColdStartMode('off'), 'off');
  assert.equal(parseColdStartMode('WARN'), 'warn');
  assert.equal(parseColdStartMode('  Enforce  '), 'enforce');
});

test('parseColdStartMode: unset or garbage defaults to warn', () => {
  assert.equal(parseColdStartMode(undefined), 'warn');
  assert.equal(parseColdStartMode(''), 'warn');
  assert.equal(parseColdStartMode('banana'), 'warn');
});

// ---- computeColdStartOutcome (pure decision core) -----------------------------------------------

test('computeColdStartOutcome: mode off never warns or blocks, even when never woken', () => {
  const out = computeColdStartOutcome('off', undefined, 1_000_000);
  assert.deepEqual(out, { cold: false, block: false, mode: 'off' });
});

test('computeColdStartOutcome: warn mode + never woken -> cold, NOT blocked (warns-not-refuses)', () => {
  const out = computeColdStartOutcome('warn', undefined, 1_000_000);
  assert.equal(out.cold, true);
  assert.equal(out.block, false, 'warn mode must never set block=true');
  assert.equal(out.mode, 'warn');
});

test('computeColdStartOutcome: warn mode + woken recently -> not cold', () => {
  const now = 10_000_000;
  const out = computeColdStartOutcome('warn', now - 1000, now);
  assert.deepEqual(out, { cold: false, block: false, mode: 'warn' });
});

test('computeColdStartOutcome: warn mode + woken but TTL expired -> cold again, still not blocked', () => {
  const now = 10_000_000;
  const out = computeColdStartOutcome('warn', now - (WAKE_TTL_MS + 1), now);
  assert.equal(out.cold, true);
  assert.equal(out.block, false);
});

test('computeColdStartOutcome: exactly at the TTL boundary still counts as awake (<=)', () => {
  const now = 10_000_000;
  const out = computeColdStartOutcome('warn', now - WAKE_TTL_MS, now);
  assert.equal(out.cold, false);
});

test('computeColdStartOutcome: enforce mode + never woken -> cold AND blocked', () => {
  const out = computeColdStartOutcome('enforce', undefined, 1_000_000);
  assert.equal(out.cold, true);
  assert.equal(out.block, true);
  assert.equal(out.mode, 'enforce');
});

test('computeColdStartOutcome: enforce mode + woken recently -> not cold, not blocked', () => {
  const now = 10_000_000;
  const out = computeColdStartOutcome('enforce', now - 5000, now);
  assert.deepEqual(out, { cold: false, block: false, mode: 'enforce' });
});

test('computeColdStartOutcome: enforce mode + TTL expired -> cold AND blocked again', () => {
  const now = 10_000_000;
  const out = computeColdStartOutcome('enforce', now - (WAKE_TTL_MS + 1), now);
  assert.equal(out.cold, true);
  assert.equal(out.block, true);
});

// ---- markWoken + evaluateColdStart (IO shell, real Map + real clock) -----------------------------

test('evaluateColdStart: an identity that never called markWoken reads as cold (default mode=warn), never blocked', () => {
  __resetColdStartState();
  const prev = process.env.COLD_START_MODE;
  delete process.env.COLD_START_MODE;
  const out = evaluateColdStart('caller-hash-never-woken');
  assert.equal(out.mode, 'warn', 'default mode must be warn');
  assert.equal(out.cold, true);
  assert.equal(out.block, false, 'default warn mode must never block');
  if (prev !== undefined) process.env.COLD_START_MODE = prev;
});

test('evaluateColdStart: after markWoken(identity), the SAME identity reads as awake', () => {
  __resetColdStartState();
  const id = 'caller-hash-abc123';
  markWoken(id);
  const out = evaluateColdStart(id);
  assert.equal(out.cold, false);
  assert.equal(out.block, false);
});

test('evaluateColdStart: waking one identity does not wake a DIFFERENT identity', () => {
  __resetColdStartState();
  markWoken('identity-A');
  const out = evaluateColdStart('identity-B');
  assert.equal(out.cold, true);
});

test('evaluateColdStart: FAIL-OPEN — an empty/unavailable identity is always allowed, never gated', () => {
  __resetColdStartState();
  const prev = process.env.COLD_START_MODE;
  process.env.COLD_START_MODE = 'enforce'; // even the strictest mode must not block a missing identity
  const out = evaluateColdStart('');
  assert.equal(out.cold, false);
  assert.equal(out.block, false, 'a missing bearer identity must never be blocked (fail-open)');
  if (prev !== undefined) process.env.COLD_START_MODE = prev; else delete process.env.COLD_START_MODE;
});

test('evaluateColdStart: enforce mode + never woken -> block=true (the enforce-mode error path registry.ts checks)', () => {
  __resetColdStartState();
  const prev = process.env.COLD_START_MODE;
  process.env.COLD_START_MODE = 'enforce';
  const out = evaluateColdStart('some-cold-identity');
  assert.equal(out.block, true);
  assert.equal(out.mode, 'enforce');
  if (prev !== undefined) process.env.COLD_START_MODE = prev; else delete process.env.COLD_START_MODE;
});

test('evaluateColdStart: mode=off is a full no-op even for a never-woken identity', () => {
  __resetColdStartState();
  const prev = process.env.COLD_START_MODE;
  process.env.COLD_START_MODE = 'off';
  const out = evaluateColdStart('never-woken-either');
  assert.deepEqual(out, { cold: false, block: false, mode: 'off' });
  if (prev !== undefined) process.env.COLD_START_MODE = prev; else delete process.env.COLD_START_MODE;
});

test('markWoken: never throws on an empty identity (best-effort bookkeeping)', () => {
  assert.doesNotThrow(() => markWoken(''));
});

// ---- constants -----------------------------------------------------------------------------------

test('COLD_START_MESSAGE carries no em/en dash (published user-facing string rule)', () => {
  assert.ok(!COLD_START_MESSAGE.includes('—'), 'no em dash');
  assert.ok(!COLD_START_MESSAGE.includes('–'), 'no en dash');
  assert.match(COLD_START_MESSAGE, /^COLD_START:/);
  assert.match(COLD_START_MESSAGE, /wake\(\)/);
});

test('WAKE_TTL_MS is the documented ~6 hours', () => {
  assert.equal(WAKE_TTL_MS, 6 * 60 * 60 * 1000);
});
