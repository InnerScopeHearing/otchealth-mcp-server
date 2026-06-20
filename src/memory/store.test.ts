import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAgent } from './store.js';

// Pure, no-network. normalizeAgent is the ring/privilege guard for the gateway memory surface.
describe('memory store normalizeAgent (ring guard)', () => {
  it('lowercases and trims a valid agent id', () => {
    assert.equal(normalizeAgent('CTO'), 'cto');
    assert.equal(normalizeAgent('  Haulai '), 'haulai');
    assert.equal(normalizeAgent('commerce'), 'commerce');
    assert.equal(normalizeAgent('clo'), 'clo');
  });

  it('REJECTS the privilege-walled clo-personal lane', () => {
    assert.throws(() => normalizeAgent('clo-personal'), /privilege-walled/);
    assert.throws(() => normalizeAgent('CLO-Personal'), /privilege-walled/);
  });

  it('rejects empty / invalid ids', () => {
    assert.throws(() => normalizeAgent(''), /required/);
    assert.throws(() => normalizeAgent('bad name!'), /invalid agent/);
    assert.throws(() => normalizeAgent('a/b'), /invalid agent/);
    assert.throws(() => normalizeAgent('x'.repeat(60)), /invalid agent/);
  });
});
