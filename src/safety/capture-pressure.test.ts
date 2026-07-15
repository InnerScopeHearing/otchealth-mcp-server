import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCaptureMode,
  parseCaptureThreshold,
  computeCapturePressureOutcome,
  buildCaptureNudgeMessage,
  recordMutation,
  recordCheckpoint,
  evaluateCapturePressure,
  __resetCapturePressureState,
  DEFAULT_CAPTURE_THRESHOLD,
} from './capture-pressure.js';

// ---- parseCaptureMode ----------------------------------------------------------------------------

test('parseCaptureMode: "off" parses to off, case-insensitive and trimmed', () => {
  assert.equal(parseCaptureMode('off'), 'off');
  assert.equal(parseCaptureMode('OFF'), 'off');
  assert.equal(parseCaptureMode('  Off  '), 'off');
});

test('parseCaptureMode: unset, garbage, or "warn" all default to warn (no enforce mode exists)', () => {
  assert.equal(parseCaptureMode(undefined), 'warn');
  assert.equal(parseCaptureMode(''), 'warn');
  assert.equal(parseCaptureMode('warn'), 'warn');
  assert.equal(parseCaptureMode('enforce'), 'warn', 'capture-pressure has no enforce mode; garbage falls back to warn');
  assert.equal(parseCaptureMode('banana'), 'warn');
});

// ---- parseCaptureThreshold ------------------------------------------------------------------------

test('parseCaptureThreshold: a valid positive integer string parses through', () => {
  assert.equal(parseCaptureThreshold('5'), 5);
  assert.equal(parseCaptureThreshold('1'), 1);
  assert.equal(parseCaptureThreshold('250'), 250);
});

test('parseCaptureThreshold: unset, garbage, zero, or negative all default to DEFAULT_CAPTURE_THRESHOLD', () => {
  assert.equal(parseCaptureThreshold(undefined), DEFAULT_CAPTURE_THRESHOLD);
  assert.equal(parseCaptureThreshold(''), DEFAULT_CAPTURE_THRESHOLD);
  assert.equal(parseCaptureThreshold('banana'), DEFAULT_CAPTURE_THRESHOLD);
  assert.equal(parseCaptureThreshold('0'), DEFAULT_CAPTURE_THRESHOLD);
  assert.equal(parseCaptureThreshold('-3'), DEFAULT_CAPTURE_THRESHOLD);
});

test('DEFAULT_CAPTURE_THRESHOLD is the documented 10', () => {
  assert.equal(DEFAULT_CAPTURE_THRESHOLD, 10);
});

// ---- computeCapturePressureOutcome (pure decision core) -------------------------------------------

test('computeCapturePressureOutcome: mode off never nudges, even with a huge mutation count', () => {
  const out = computeCapturePressureOutcome('off', 1_000_000, 10);
  assert.deepEqual(out, { nudge: false, mutations: 1_000_000, threshold: 10, mode: 'off' });
});

test('computeCapturePressureOutcome: mutations below threshold does not nudge', () => {
  const out = computeCapturePressureOutcome('warn', 9, 10);
  assert.equal(out.nudge, false);
});

test('computeCapturePressureOutcome: mutations exactly AT threshold nudges (boundary is inclusive)', () => {
  const out = computeCapturePressureOutcome('warn', 10, 10);
  assert.equal(out.nudge, true);
});

test('computeCapturePressureOutcome: mutations above threshold nudges', () => {
  const out = computeCapturePressureOutcome('warn', 11, 10);
  assert.equal(out.nudge, true);
});

test('computeCapturePressureOutcome: zero mutations never nudges', () => {
  const out = computeCapturePressureOutcome('warn', 0, 10);
  assert.equal(out.nudge, false);
});

// ---- buildCaptureNudgeMessage ----------------------------------------------------------------------

test('buildCaptureNudgeMessage: carries the mutation count and no em/en dash (published-string rule)', () => {
  const msg = buildCaptureNudgeMessage(14);
  assert.match(msg, /^CAPTURE_PRESSURE:/);
  assert.match(msg, /14 mutations/);
  assert.match(msg, /checkpoint\(agent\)/);
  assert.ok(!msg.includes('—'), 'no em dash');
  assert.ok(!msg.includes('–'), 'no en dash');
});

// ---- recordMutation / recordCheckpoint / evaluateCapturePressure (IO shell) -----------------------

test('evaluateCapturePressure: an identity that never mutated reads as 0 mutations, never nudged', () => {
  __resetCapturePressureState();
  const out = evaluateCapturePressure('caller-never-mutated');
  assert.equal(out.mutations, 0);
  assert.equal(out.nudge, false);
});

test('recordMutation: increments the per-identity counter one call at a time', () => {
  __resetCapturePressureState();
  const id = 'caller-increment';
  recordMutation(id);
  recordMutation(id);
  recordMutation(id);
  const out = evaluateCapturePressure(id);
  assert.equal(out.mutations, 3);
});

test('recordMutation: waking one identity does not affect a DIFFERENT identity', () => {
  __resetCapturePressureState();
  recordMutation('identity-A');
  recordMutation('identity-A');
  const outA = evaluateCapturePressure('identity-A');
  const outB = evaluateCapturePressure('identity-B');
  assert.equal(outA.mutations, 2);
  assert.equal(outB.mutations, 0);
});

test('evaluateCapturePressure: crossing the threshold (default 10) nudges', () => {
  __resetCapturePressureState();
  const prev = process.env.CAPTURE_PRESSURE_THRESHOLD;
  delete process.env.CAPTURE_PRESSURE_THRESHOLD;
  const id = 'caller-threshold';
  for (let i = 0; i < 10; i++) recordMutation(id);
  const out = evaluateCapturePressure(id);
  assert.equal(out.mutations, 10);
  assert.equal(out.nudge, true);
  if (prev !== undefined) process.env.CAPTURE_PRESSURE_THRESHOLD = prev;
});

test('evaluateCapturePressure: one mutation below a custom threshold does not nudge yet', () => {
  __resetCapturePressureState();
  const prev = process.env.CAPTURE_PRESSURE_THRESHOLD;
  process.env.CAPTURE_PRESSURE_THRESHOLD = '5';
  const id = 'caller-custom-threshold';
  for (let i = 0; i < 4; i++) recordMutation(id);
  const out = evaluateCapturePressure(id);
  assert.equal(out.mutations, 4);
  assert.equal(out.threshold, 5);
  assert.equal(out.nudge, false);
  if (prev !== undefined) process.env.CAPTURE_PRESSURE_THRESHOLD = prev; else delete process.env.CAPTURE_PRESSURE_THRESHOLD;
});

test('recordCheckpoint: resets the mutation streak to 0, clearing a live nudge', () => {
  __resetCapturePressureState();
  const prev = process.env.CAPTURE_PRESSURE_THRESHOLD;
  process.env.CAPTURE_PRESSURE_THRESHOLD = '3';
  const id = 'caller-checkpoint-reset';
  for (let i = 0; i < 3; i++) recordMutation(id);
  assert.equal(evaluateCapturePressure(id).nudge, true, 'sanity: nudge is live before the checkpoint');
  recordCheckpoint(id);
  const out = evaluateCapturePressure(id);
  assert.equal(out.mutations, 0);
  assert.equal(out.nudge, false);
  if (prev !== undefined) process.env.CAPTURE_PRESSURE_THRESHOLD = prev; else delete process.env.CAPTURE_PRESSURE_THRESHOLD;
});

test('recordCheckpoint: mutations accumulated AFTER a checkpoint count fresh, independent of the prior streak', () => {
  __resetCapturePressureState();
  const prev = process.env.CAPTURE_PRESSURE_THRESHOLD;
  process.env.CAPTURE_PRESSURE_THRESHOLD = '3';
  const id = 'caller-post-checkpoint';
  for (let i = 0; i < 3; i++) recordMutation(id);
  recordCheckpoint(id);
  recordMutation(id);
  recordMutation(id);
  const out = evaluateCapturePressure(id);
  assert.equal(out.mutations, 2);
  assert.equal(out.nudge, false);
  if (prev !== undefined) process.env.CAPTURE_PRESSURE_THRESHOLD = prev; else delete process.env.CAPTURE_PRESSURE_THRESHOLD;
});

test('mode off: never nudges even after crossing the threshold many times over', () => {
  __resetCapturePressureState();
  const prevMode = process.env.CAPTURE_MODE;
  const prevThreshold = process.env.CAPTURE_PRESSURE_THRESHOLD;
  process.env.CAPTURE_MODE = 'off';
  process.env.CAPTURE_PRESSURE_THRESHOLD = '2';
  const id = 'caller-mode-off';
  for (let i = 0; i < 20; i++) recordMutation(id);
  const out = evaluateCapturePressure(id);
  assert.equal(out.nudge, false);
  assert.equal(out.mode, 'off');
  if (prevMode !== undefined) process.env.CAPTURE_MODE = prevMode; else delete process.env.CAPTURE_MODE;
  if (prevThreshold !== undefined) process.env.CAPTURE_PRESSURE_THRESHOLD = prevThreshold; else delete process.env.CAPTURE_PRESSURE_THRESHOLD;
});

test('FAIL-OPEN: recordMutation/recordCheckpoint never throw on an empty identity', () => {
  assert.doesNotThrow(() => recordMutation(''));
  assert.doesNotThrow(() => recordCheckpoint(''));
});

test('FAIL-OPEN: evaluateCapturePressure on an empty identity never nudges, regardless of mode', () => {
  __resetCapturePressureState();
  const prev = process.env.CAPTURE_MODE;
  process.env.CAPTURE_MODE = 'warn';
  const out = evaluateCapturePressure('');
  assert.equal(out.nudge, false);
  assert.equal(out.mutations, 0);
  if (prev !== undefined) process.env.CAPTURE_MODE = prev; else delete process.env.CAPTURE_MODE;
});
