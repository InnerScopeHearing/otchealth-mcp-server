import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseJitDoctrineMode,
  jitDoctrineFor,
  shouldSurfaceDoctrine,
  evaluateJitDoctrine,
  __resetJitDoctrineState,
  JIT_DOCTRINE_BINDINGS,
} from './jit-doctrine.js';

// ---- parseJitDoctrineMode -------------------------------------------------------------------------

test('parseJitDoctrineMode: valid modes pass through, case-insensitive and trimmed', () => {
  assert.equal(parseJitDoctrineMode('off'), 'off');
  assert.equal(parseJitDoctrineMode('OFF'), 'off');
  assert.equal(parseJitDoctrineMode('  warn  '), 'warn');
  assert.equal(parseJitDoctrineMode('WARN'), 'warn');
});

test('parseJitDoctrineMode: unset, garbage, or "enforce" all default to warn (no enforce mode exists)', () => {
  assert.equal(parseJitDoctrineMode(undefined), 'warn');
  assert.equal(parseJitDoctrineMode(''), 'warn');
  assert.equal(parseJitDoctrineMode('banana'), 'warn');
  assert.equal(parseJitDoctrineMode('enforce'), 'warn', 'jit-doctrine has no enforce mode; garbage falls back to warn');
});

// ---- jitDoctrineFor (pure decision core) -----------------------------------------------------------

test('jitDoctrineFor: an exact-match tool name returns its bound pitfall(s)', () => {
  const out = jitDoctrineFor('azure_containerapp_set_env');
  assert.equal(out.length, 1);
  assert.match(out[0], /inline oauth-clients secret/);
});

test('jitDoctrineFor: a prefix binding matches a tool that starts with it', () => {
  const out = jitDoctrineFor('n8n_create_workflow');
  assert.equal(out.length, 1);
  assert.match(out[0], /n8n Cloud/);
});

test('jitDoctrineFor: prefix binding matches every tool under that service surface', () => {
  for (const name of ['posthog_query_hogql', 'posthog_insight_list', 'posthog_project_update']) {
    const out = jitDoctrineFor(name);
    assert.equal(out.length, 1, `expected a posthog_ binding to fire for ${name}`);
    assert.match(out[0], /MedReview \(PHI\) project 468398/);
  }
});

test('jitDoctrineFor: legal_blob_ prefix matches get/list/put', () => {
  for (const name of ['legal_blob_get', 'legal_blob_list', 'legal_blob_put']) {
    const out = jitDoctrineFor(name);
    assert.equal(out.length, 1, `expected a legal_blob_ binding to fire for ${name}`);
    assert.match(out[0], /privileged/);
  }
});

test('jitDoctrineFor: an unrecognized tool name returns an empty array', () => {
  assert.deepEqual(jitDoctrineFor('some_totally_unbound_tool'), []);
});

test('jitDoctrineFor: an empty tool name returns an empty array, never throws', () => {
  assert.doesNotThrow(() => {
    assert.deepEqual(jitDoctrineFor(''), []);
  });
});

test('jitDoctrineFor: exact bindings do NOT prefix-match (kind matters)', () => {
  // llm_azure is bound as kind:'exact'. A longer tool name that merely starts with the same
  // string must NOT match -- only an EXACT binding of kind:'prefix' would do that.
  assert.deepEqual(jitDoctrineFor('llm_azure_extended_variant'), []);
  assert.deepEqual(jitDoctrineFor('llm_azure'), [
    'gpt-4.1-mini is banned for quality summarization; it degrades output. Use gpt-4o or the standard tier for summarization-quality-sensitive work.',
  ]);
});

test('jitDoctrineFor: kb_search_privileged is exact, kb_search alone does not match it', () => {
  assert.deepEqual(jitDoctrineFor('kb_search'), []);
  assert.equal(jitDoctrineFor('kb_search_privileged').length, 1);
});

test('jitDoctrineFor: memory_write and memory_remember are distinct exact bindings', () => {
  assert.equal(jitDoctrineFor('memory_write').length, 1);
  assert.equal(jitDoctrineFor('memory_remember').length, 1);
  assert.notEqual(jitDoctrineFor('memory_write')[0], jitDoctrineFor('memory_remember')[0]);
  // Neither is a prefix of a real different tool in the table, so a lookalike name is empty.
  assert.deepEqual(jitDoctrineFor('memory_write_batch'), []);
});

test('jitDoctrineFor: depot_trigger_build and shopify_create_product exact bindings fire', () => {
  assert.equal(jitDoctrineFor('depot_trigger_build').length, 1);
  assert.match(jitDoctrineFor('depot_trigger_build')[0], /depot-macos-26/);
  assert.equal(jitDoctrineFor('shopify_create_product').length, 1);
  assert.match(jitDoctrineFor('shopify_create_product')[0], /PSAP/);
});

test('jitDoctrineFor: azure_job_execute and azure_job_upsert are distinct exact bindings', () => {
  assert.match(jitDoctrineFor('azure_job_execute')[0], /skew-proof image/);
  assert.match(jitDoctrineFor('azure_job_upsert')[0], /proper array/);
});

// ---- shouldSurfaceDoctrine (IO shell throttle) ------------------------------------------------------

test('shouldSurfaceDoctrine: the first call for a (caller, tool) pair returns true', () => {
  __resetJitDoctrineState();
  assert.equal(shouldSurfaceDoctrine('caller-1', 'toolA'), true);
});

test('shouldSurfaceDoctrine: a repeat call for the SAME (caller, tool) pair returns false', () => {
  __resetJitDoctrineState();
  assert.equal(shouldSurfaceDoctrine('caller-1', 'toolA'), true);
  assert.equal(shouldSurfaceDoctrine('caller-1', 'toolA'), false);
  assert.equal(shouldSurfaceDoctrine('caller-1', 'toolA'), false, 'stays throttled on further repeats');
});

test('shouldSurfaceDoctrine: throttling one tool for a caller does not throttle a DIFFERENT tool for the same caller', () => {
  __resetJitDoctrineState();
  assert.equal(shouldSurfaceDoctrine('caller-1', 'toolA'), true);
  assert.equal(shouldSurfaceDoctrine('caller-1', 'toolA'), false);
  assert.equal(shouldSurfaceDoctrine('caller-1', 'toolB'), true, 'a different tool is a fresh key');
});

test('shouldSurfaceDoctrine: throttling one caller does not throttle a DIFFERENT caller on the same tool', () => {
  __resetJitDoctrineState();
  assert.equal(shouldSurfaceDoctrine('caller-1', 'toolA'), true);
  assert.equal(shouldSurfaceDoctrine('caller-1', 'toolA'), false);
  assert.equal(shouldSurfaceDoctrine('caller-2', 'toolA'), true, 'a different caller is a fresh key');
});

test('shouldSurfaceDoctrine: __resetJitDoctrineState clears the throttle so the same pair surfaces again', () => {
  __resetJitDoctrineState();
  assert.equal(shouldSurfaceDoctrine('caller-1', 'toolA'), true);
  assert.equal(shouldSurfaceDoctrine('caller-1', 'toolA'), false);
  __resetJitDoctrineState();
  assert.equal(shouldSurfaceDoctrine('caller-1', 'toolA'), true, 'reset forgets prior throttle state');
});

test('shouldSurfaceDoctrine: never throws, even on empty callerHash/toolName', () => {
  __resetJitDoctrineState();
  assert.doesNotThrow(() => shouldSurfaceDoctrine('', ''));
});

// ---- evaluateJitDoctrine (IO shell, mode + throttle combined) --------------------------------------

test('evaluateJitDoctrine: default mode (unset env) is warn', () => {
  __resetJitDoctrineState();
  const prev = process.env.JIT_DOCTRINE_MODE;
  delete process.env.JIT_DOCTRINE_MODE;
  const out = evaluateJitDoctrine('caller-default-mode', 'azure_containerapp_set_env');
  assert.equal(out.mode, 'warn');
  if (prev !== undefined) process.env.JIT_DOCTRINE_MODE = prev;
});

test('evaluateJitDoctrine: a bound tool on its first call for this caller returns the pitfall(s)', () => {
  __resetJitDoctrineState();
  const out = evaluateJitDoctrine('caller-evalA', 'azure_job_upsert');
  assert.equal(out.pitfalls.length, 1);
  assert.match(out.pitfalls[0], /proper array/);
  assert.equal(out.mode, 'warn');
});

test('evaluateJitDoctrine: the SAME (caller, tool) pair is throttled on the second call, even though the binding still exists', () => {
  __resetJitDoctrineState();
  const first = evaluateJitDoctrine('caller-evalB', 'azure_job_upsert');
  assert.equal(first.pitfalls.length, 1, 'sanity: first call surfaces it');
  const second = evaluateJitDoctrine('caller-evalB', 'azure_job_upsert');
  assert.deepEqual(second.pitfalls, [], 'second call for the same pair is throttled to empty');
  assert.equal(second.mode, 'warn', 'mode is still reported even when throttled');
});

test('evaluateJitDoctrine: an unbound tool returns empty pitfalls regardless of caller', () => {
  __resetJitDoctrineState();
  const out = evaluateJitDoctrine('caller-evalC', 'some_unbound_tool_xyz');
  assert.deepEqual(out.pitfalls, []);
});

test('evaluateJitDoctrine: mode off returns empty pitfalls even for a freshly-bound tool', () => {
  __resetJitDoctrineState();
  const prev = process.env.JIT_DOCTRINE_MODE;
  process.env.JIT_DOCTRINE_MODE = 'off';
  const out = evaluateJitDoctrine('caller-evalD', 'azure_containerapp_set_env');
  assert.deepEqual(out, { pitfalls: [], mode: 'off' });
  if (prev !== undefined) process.env.JIT_DOCTRINE_MODE = prev; else delete process.env.JIT_DOCTRINE_MODE;
});

test('evaluateJitDoctrine: mode off never consumes the throttle -- flipping back to warn still surfaces once', () => {
  __resetJitDoctrineState();
  const prev = process.env.JIT_DOCTRINE_MODE;
  process.env.JIT_DOCTRINE_MODE = 'off';
  const offOut = evaluateJitDoctrine('caller-evalE', 'depot_trigger_build');
  assert.deepEqual(offOut.pitfalls, []);
  process.env.JIT_DOCTRINE_MODE = 'warn';
  const warnOut = evaluateJitDoctrine('caller-evalE', 'depot_trigger_build');
  assert.equal(warnOut.pitfalls.length, 1, 'mode off must not have silently consumed the once-per-pair throttle');
  if (prev !== undefined) process.env.JIT_DOCTRINE_MODE = prev; else delete process.env.JIT_DOCTRINE_MODE;
});

test('evaluateJitDoctrine: the throttle is scoped per (caller, tool) -- a different caller is still fresh', () => {
  __resetJitDoctrineState();
  const a1 = evaluateJitDoctrine('caller-evalF-1', 'memory_write');
  const a2 = evaluateJitDoctrine('caller-evalF-1', 'memory_write');
  const b1 = evaluateJitDoctrine('caller-evalF-2', 'memory_write');
  assert.equal(a1.pitfalls.length, 1);
  assert.deepEqual(a2.pitfalls, []);
  assert.equal(b1.pitfalls.length, 1, 'a different caller is unaffected by caller-evalF-1 having been throttled');
});

test('FAIL-OPEN: evaluateJitDoctrine never throws on empty callerHash or toolName', () => {
  __resetJitDoctrineState();
  assert.doesNotThrow(() => evaluateJitDoctrine('', ''));
  assert.doesNotThrow(() => evaluateJitDoctrine('', 'azure_job_upsert'));
  assert.doesNotThrow(() => evaluateJitDoctrine('some-caller', ''));
});

test('FAIL-OPEN: evaluateJitDoctrine on an empty toolName returns empty pitfalls', () => {
  __resetJitDoctrineState();
  const out = evaluateJitDoctrine('caller-evalG', '');
  assert.deepEqual(out.pitfalls, []);
});

// ---- table integrity -------------------------------------------------------------------------------

test('JIT_DOCTRINE_BINDINGS: every binding has at least one non-empty pitfall string', () => {
  for (const binding of JIT_DOCTRINE_BINDINGS) {
    assert.ok(binding.pitfalls.length > 0, `binding for "${binding.match}" has no pitfalls`);
    for (const p of binding.pitfalls) {
      assert.ok(p.trim().length > 0, `binding for "${binding.match}" has an empty pitfall string`);
    }
  }
});

test('JIT_DOCTRINE_BINDINGS: seeded with the 12 real ledgered bindings', () => {
  assert.equal(JIT_DOCTRINE_BINDINGS.length, 12);
});

test('JIT_DOCTRINE_BINDINGS: no pitfall string anywhere in the table contains an em or en dash (published-string rule)', () => {
  for (const binding of JIT_DOCTRINE_BINDINGS) {
    for (const p of binding.pitfalls) {
      assert.ok(!p.includes('—'), `binding for "${binding.match}" pitfall contains an em dash: ${p}`);
      assert.ok(!p.includes('–'), `binding for "${binding.match}" pitfall contains an en dash: ${p}`);
    }
  }
});

test('JIT_DOCTRINE_BINDINGS: every kind is either exact or prefix', () => {
  for (const binding of JIT_DOCTRINE_BINDINGS) {
    assert.ok(binding.kind === 'exact' || binding.kind === 'prefix', `unexpected kind on "${binding.match}"`);
  }
});
