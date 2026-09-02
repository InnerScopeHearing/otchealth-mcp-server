import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveAttribution } from './attribution.js';

// FND-20260829-878f. Pure-function tests, no env/Cosmos/Postgres needed.

test('resolveAttribution: token and claimed match exactly -> actor is the token value, no claimed_actor', () => {
  const r = resolveAttribution('cto', 'cto');
  assert.equal(r.actor, 'cto');
  assert.equal(r.claimed_actor, undefined);
});

test('resolveAttribution: match is case-insensitive (agent ids are conventionally lowercase but should not false-positive on case drift)', () => {
  const r = resolveAttribution('cto', 'CTO');
  assert.equal(r.actor, 'cto');
  assert.equal(r.claimed_actor, undefined);
});

test('SAFETY-CRITICAL: a connector-lane token (coo) claiming "cto" is recorded under its REAL lane, with the claim preserved for audit', () => {
  const r = resolveAttribution('coo', 'cto');
  assert.equal(r.actor, 'coo', 'the token-bound identity is always the recorded actor');
  assert.equal(r.claimed_actor, 'cto', 'the caller-supplied identity is preserved, never trusted as the truth');
});

test('SAFETY-CRITICAL: a cro connector-lane token claiming to be "cfo" is recorded as cro, not cfo', () => {
  const r = resolveAttribution('cro', 'cfo');
  assert.equal(r.actor, 'cro');
  assert.equal(r.claimed_actor, 'cfo');
});

test('resolveAttribution: an empty claimed value (e.g. a caller who omitted an optional-in-spirit field) just uses the token, no claimed_actor', () => {
  const r = resolveAttribution('cto', '');
  assert.equal(r.actor, 'cto');
  assert.equal(r.claimed_actor, undefined);
});

test('resolveAttribution: whitespace-only claimed value is treated as empty', () => {
  const r = resolveAttribution('cto', '   ');
  assert.equal(r.actor, 'cto');
  assert.equal(r.claimed_actor, undefined);
});

test('resolveAttribution: leading/trailing whitespace on a genuine mismatch is trimmed before recording', () => {
  const r = resolveAttribution('  coo  ', '  cto  ');
  assert.equal(r.actor, 'coo');
  assert.equal(r.claimed_actor, 'cto');
});

test('resolveAttribution: no token-bound identity at all falls back to the caller-supplied value verbatim (defensive path, not the expected one)', () => {
  const r = resolveAttribution('', 'matt');
  assert.equal(r.actor, 'matt');
  assert.equal(r.claimed_actor, undefined);
});

test('resolveAttribution: neither a token nor a claim resolves to an empty actor (unchanged pre-existing behavior downstream: normalizeAgent("") throws, this function itself never throws)', () => {
  const r = resolveAttribution('', '');
  assert.equal(r.actor, '');
  assert.equal(r.claimed_actor, undefined);
});
