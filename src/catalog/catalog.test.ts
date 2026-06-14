import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recordTool, deriveService, listTools, serviceCapabilities, auditUnused } from './catalog.js';

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
  assert.ok(caps.available_not_wired.length > 0); // stripe has declared backlog (subscriptions, invoices, ...)
});

test('auditUnused surfaces planned services (e.g. depot) and partial coverage', () => {
  const audit = auditUnused();
  assert.ok(audit.planned_services.some((s) => s.service === 'depot'));
  assert.ok(typeof audit.summary === 'string' && audit.summary.length > 0);
});
