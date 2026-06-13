import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CATALOG, getServiceManifest, listServiceNames } from './manifest.js';

test('catalog lists every Phase 1 + Phase 2 service', () => {
  const names = listServiceNames();
  for (const expected of [
    'customerio',
    'shopify',
    'intercom',
    'n8n',
    'cloudflare',
    'graph',
    'stripe',
    'depot',
    'posthog',
  ]) {
    assert.ok(names.includes(expected), `manifest missing service ${expected}`);
  }
});

test('getServiceManifest is case-insensitive and trims', () => {
  assert.equal(getServiceManifest('  DePoT  ')?.service, 'depot');
  assert.equal(getServiceManifest('nope'), undefined);
});

test('wired capabilities carry a toolName; unwired do not require one', () => {
  for (const svc of CATALOG) {
    for (const cap of svc.capabilities) {
      if (cap.wired) {
        assert.ok(cap.toolName, `${svc.service}.${cap.id} is wired but has no toolName`);
      }
    }
  }
});

test('PostHog PHI carve-out capabilities are present and never wired', () => {
  const posthog = getServiceManifest('posthog');
  assert.ok(posthog);
  const carveOuts = ['session_recordings', 'query_events', 'persons'];
  for (const id of carveOuts) {
    const cap = posthog!.capabilities.find((c) => c.id === id);
    assert.ok(cap, `posthog missing carve-out capability ${id}`);
    assert.equal(cap!.wired, false, `posthog.${id} must never be wired`);
    assert.match(cap!.note ?? '', /INTENTIONALLY NEVER WIRED/i);
  }
  // The posthog service is flagged as a PHI carve-out ring.
  assert.equal(posthog!.ring, 'phi-carve-out');
});

test('depot manifest covers the full surface incl. the guarded destructive write', () => {
  const depot = getServiceManifest('depot');
  assert.ok(depot);
  const reset = depot!.capabilities.find((c) => c.id === 'reset_cache');
  assert.ok(reset);
  assert.equal(reset!.writeClass, 'destructive');
  assert.equal(reset!.wired, true);
  assert.equal(reset!.toolName, 'depot_reset_cache');
});
