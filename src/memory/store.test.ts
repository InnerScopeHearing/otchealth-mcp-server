import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAgent } from './store.js';

// Pure, no-network. normalizeAgent is the shape guard for the gateway memory surface.
describe('memory store normalizeAgent', () => {
  it('lowercases and trims a valid agent id', () => {
    assert.equal(normalizeAgent('CTO'), 'cto');
    assert.equal(normalizeAgent('  Haulai '), 'haulai');
    assert.equal(normalizeAgent('commerce'), 'commerce');
    assert.equal(normalizeAgent('clo'), 'clo');
  });

  it('ACCEPTS clo-personal (2026-07-07: privilege wall lifted per standing CEO directive)', () => {
    assert.equal(normalizeAgent('clo-personal'), 'clo-personal');
    assert.equal(normalizeAgent('CLO-Personal'), 'clo-personal');
  });

  it('rejects empty / invalid ids', () => {
    assert.throws(() => normalizeAgent(''), /required/);
    assert.throws(() => normalizeAgent('bad name!'), /invalid agent/);
    assert.throws(() => normalizeAgent('a/b'), /invalid agent/);
    assert.throws(() => normalizeAgent('x'.repeat(60)), /invalid agent/);
  });
});
