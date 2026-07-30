import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recordTool, deriveService, listTools, serviceCapabilities, auditUnused, catalogVersion, allTools } from './catalog.js';

test('deriveService takes the prefix before the first underscore', () => {
  assert.equal(deriveService('stripe_get_balance'), 'stripe');
  assert.equal(deriveService('catalog_list_tools'), 'catalog');
  assert.equal(deriveService('noUnderscore'), 'noUnderscore');
});

test('recordTool + listTools groups by service and is idempotent by name', () => {
  recordTool({ name: 'stripe_get_balance', service: 'stripe', category: 'read', title: 'Get balance', description: '', readOnly: true });
  recordTool({ name: 'stripe_list_charges', service: 'stripe', category: 'read', title: 'List charges', description: '', readOnly: true });
  // duplicate name updates in place (no double-count)
  recordTool({ name: 'stripe_get_balance', service: 'stripe', category: 'read', title: 'Get balance', description: '', readOnly: true });

  const stripe = listTools('stripe');
  assert.equal(stripe.length, 1);
  assert.equal(stripe[0].service, 'stripe');
  assert.equal(stripe[0].tool_count, 2);
  assert.deepEqual(stripe[0].tools.map((t) => t.name), ['stripe_get_balance', 'stripe_list_charges']);
});

test('serviceCapabilities reports wired tools + known available-not-wired surface', () => {
  recordTool({ name: 'stripe_get_balance', service: 'stripe', category: 'read', title: 'Get balance', description: '', readOnly: true });
  const caps = serviceCapabilities('stripe');
  assert.equal(caps.known, true);
  assert.ok(caps.wired_tools.includes('stripe_get_balance'));
  // Wired services now carry an empty backlog; a PLANNED service still declares its available
  // surface (mercury is planned + never wired, so this is independent of registration state).
  assert.ok(serviceCapabilities('mercury').available_not_wired.length > 0);
});

test('auditUnused surfaces planned services (e.g. depot) and partial coverage', () => {
  const audit = auditUnused();
  // mercury is a status:'planned' service and is never wired, so it is always in planned_services
  // (unlike depot, which main has since wired).
  assert.ok(audit.planned_services.some((s) => s.service === 'mercury'));
  assert.ok(typeof audit.summary === 'string' && audit.summary.length > 0);
});

// -- catalogVersion (CFO P1-A, 2026-07-30): a client-detectable staleness fingerprint ------------

test('catalogVersion is deterministic for the same registered tool set', () => {
  const before = allTools().length;
  recordTool({ name: 'zzz_stable_probe_a', service: 'zzz', category: 'read', title: 'a', description: '', readOnly: true });
  recordTool({ name: 'zzz_stable_probe_b', service: 'zzz', category: 'read', title: 'b', description: '', readOnly: true });
  const v1 = catalogVersion();
  const v2 = catalogVersion();
  assert.equal(v1, v2);
  assert.equal(typeof v1, 'string');
  assert.ok(v1.length > 0);
  assert.equal(allTools().length, before + 2);
});

test('catalogVersion changes when a NEW tool is registered (the staleness signal a client compares against)', () => {
  const v1 = catalogVersion();
  recordTool({ name: 'zzz_new_probe_tool', service: 'zzz', category: 'read', title: 'new', description: '', readOnly: true });
  const v2 = catalogVersion();
  assert.notEqual(v1, v2);
});

test('catalogVersion changes when an EXISTING tool is recategorized (not just on add/remove)', () => {
  recordTool({ name: 'zzz_recat_probe', service: 'zzz', category: 'read', title: 'r', description: '', readOnly: true });
  const v1 = catalogVersion();
  recordTool({ name: 'zzz_recat_probe', service: 'zzz', category: 'write_simple', title: 'r', description: '', readOnly: false });
  const v2 = catalogVersion();
  assert.notEqual(v1, v2);
});

test('catalogVersion is order-independent (registration order never changes the fingerprint)', () => {
  const registered = allTools();
  // Recording the same set again (idempotent by name, per recordTool's own contract) in a
  // different order must not change the version — the fingerprint sorts before hashing.
  const v1 = catalogVersion();
  for (const t of [...registered].reverse()) recordTool(t);
  const v2 = catalogVersion();
  assert.equal(v1, v2);
});
