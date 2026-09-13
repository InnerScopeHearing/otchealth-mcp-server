import assert from 'node:assert/strict';
import test from 'node:test';

for (const [key, value] of Object.entries({
  CIO_SITE_ID: 'synthetic', CIO_TRACK_KEY: 'synthetic', CIO_APP_API_BEARER: 'synthetic',
  PERPLEXITY_CONNECTOR_TOKEN: 'synthetic-placeholder-value-000000000',
  ADMIN_REVOKE_TOKEN: 'synthetic-placeholder-value-000000000', N8N_WEBHOOK_SECRET: 'synthetic-placeholder-value-000000000',
})) process.env[key] ??= value;

async function fixtureWithPublishedHistory(options: Record<string, unknown> = {}) {
  const { createLocalBrainAssertionRouteFixture } = await import(new URL('../../tools/relationship-artifacts/brain-assertion-local-fixture.mjs', import.meta.url).href);
  return createLocalBrainAssertionRouteFixture(options);
}

async function inject(fixture: any, payload: unknown, authorization: string | null = `Bearer ${fixture.context.raw_token}`) {
  return fixture.app.inject({
    method: 'POST',
    url: `/relationship-publications/v1/${fixture.input.cohort_id}/${fixture.input.producer_id}/assertion-brief`,
    ...(authorization === null ? {} : { headers: { authorization } }),
    payload,
  });
}

test('assertion brief is a bounded authorized projection and abstains on unknown valid time', async () => {
  const fixture = await fixtureWithPublishedHistory();
  const request = { histories: fixture.input.histories };
  try {
    const response = await inject(fixture, { ...request, temporal: { mode: 'current' } });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.schema, 'relationship-publication-assertion-brief-v1');
    assert.deepEqual(body.selection, { selected_history_count: 1, unselected_history_coverage: 'unknown' });
    assert.equal(body.temporal.mode, 'current');
    assert.equal(body.temporal.observed_at, '2026-09-13T12:00:00.000Z');
    assert.equal(body.temporal.valid_at, body.temporal.observed_at, 'the gateway, not the caller, determines current observed time');
    // The real durable fixture is time-unknown.  It must not be promoted to a current assertion.
    assert.deepEqual(body.assertions, []);
    assert.equal(response.body.includes('prepared_text'), false);
    assert.equal(response.body.includes('Synthetic'), false);
  } finally { await fixture.close(); }
});

test('assertion brief returns a verified exact-witness claim only after real durable publication', async () => {
  const fixture = await fixtureWithPublishedHistory({ exactValidTime: true });
  const request = { histories: fixture.input.histories };
  try {
    const response = await inject(fixture, { ...request, temporal: { mode: 'current' } });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.assertions.length, 1);
    const assertion = body.assertions[0]!;
    assert.equal(assertion.status, 'verified');
    assert.equal(assertion.lifecycle, 'active');
    assert.match(assertion.statement, /^typed relationship: /);
    assert.deepEqual(assertion.validTime, { basis: 'exact', start: '2026-09-13T11:00:00.000Z', end: '2026-09-13T13:00:00.000Z' });
    assert.equal(assertion.evidence[0].span.offsetUnit, 'bytes');
    assert.match(assertion.evidence[0].immutableVersion, /^[a-f0-9]{64}$/);
    assert.equal(response.body.includes('prepared_text'), false);
    assert.equal(response.body.includes('Synthetic'), false);

    const inside = await inject(fixture, { ...request, temporal: { mode: 'valid-at', valid_at: '2026-09-13T11:30:00.000Z' } });
    assert.equal(inside.statusCode, 200);
    assert.equal(inside.json().assertions.length, 1, 'valid-at includes an exact interval interior');
    const end = await inject(fixture, { ...request, temporal: { mode: 'valid-at', valid_at: '2026-09-13T13:00:00.000Z' } });
    assert.equal(end.statusCode, 200);
    assert.deepEqual(end.json().assertions, [], 'the valid-time end is exclusive');

    const knownAtRecord = await inject(fixture, { ...request, temporal: { mode: 'known-as-of', valid_at: '2026-09-13T11:30:00.000Z', known_as_of: '2026-09-13T12:00:00.000Z' } });
    assert.equal(knownAtRecord.statusCode, 200);
    assert.equal(knownAtRecord.json().assertions[0]!.lifecycle, 'active', 'known-as-of includes the recorded-at boundary and retains lifecycle');
    const beforeRecord = await inject(fixture, { ...request, temporal: { mode: 'known-as-of', valid_at: '2026-09-13T11:30:00.000Z', known_as_of: '2026-09-13T11:59:59.000Z' } });
    assert.equal(beforeRecord.statusCode, 200);
    assert.deepEqual(beforeRecord.json().assertions, [], 'known-as-of abstains before the assertion was recorded');
  } finally { await fixture.close(); }
});

test('assertion brief strictly validates temporal modes without treating unknown time as applicable', async () => {
  const fixture = await fixtureWithPublishedHistory();
  const request = { histories: fixture.input.histories };
  try {
    for (const temporal of [
      { mode: 'current', observed_at: '2026-09-13T12:00:00.000Z' },
      { mode: 'valid-at', valid_at: '2026-09-13' },
      { mode: 'known-as-of', valid_at: '2026-09-13T06:00:00.000Z', known_as_of: '2026-09-13T12:00:00.001Z' },
      { mode: 'unknown' },
    ]) {
      const response = await inject(fixture, { ...request, temporal });
      assert.equal(response.statusCode, 400);
    }
    const historical = await inject(fixture, { ...request, temporal: { mode: 'known-as-of', valid_at: '2026-09-13T06:00:00.000Z', known_as_of: '2026-09-13T12:00:00.000Z' } });
    assert.equal(historical.statusCode, 200);
    assert.deepEqual(historical.json().assertions, []);
  } finally { await fixture.close(); }
});

test('assertion brief inherits source, identity, policy, and authenticated scope denial gates', async () => {
  const fixture = await fixtureWithPublishedHistory();
  const request = { histories: fixture.input.histories };
  try {
    fixture.state.sourceCurrent = false;
    assert.equal((await inject(fixture, { ...request, temporal: { mode: 'current' } })).statusCode, 403);
    fixture.state.sourceCurrent = true;
    fixture.state.identityCurrent = false;
    assert.equal((await inject(fixture, { ...request, temporal: { mode: 'current' } })).statusCode, 403);
    fixture.state.identityCurrent = true;
    fixture.state.sourceCurrent = 'late';
    assert.equal((await inject(fixture, { ...request, temporal: { mode: 'current' } })).statusCode, 403);
    fixture.state.sourceCurrent = true;
    fixture.state.policyChange = true;
    assert.equal((await inject(fixture, { ...request, temporal: { mode: 'current' } })).statusCode, 403);
    assert.equal((await inject(fixture, { ...request, scope: 'legal_company', temporal: { mode: 'current' } })).statusCode, 400);
  } finally { await fixture.close(); }
});

test('assertion brief authenticates the Fastify request and rejects late auth changes at recheck', async () => {
  const fixture = await fixtureWithPublishedHistory({ exactValidTime: true });
  const request = { histories: fixture.input.histories, temporal: { mode: 'current' } };
  try {
    assert.equal((await inject(fixture, request, null)).statusCode, 403, 'missing bearer is never ambiently trusted');
    fixture.state.authChecks = 0;
    fixture.state.revokeAuthAfterChecks = 1;
    assert.equal((await inject(fixture, request)).statusCode, 403, 'a bearer revoked during replay fails the final recheck');
    fixture.state.revokeAuthAfterChecks = null;
    fixture.state.authChecks = 0;
    fixture.state.changeCallerHashAfterChecks = 1;
    assert.equal((await inject(fixture, request)).statusCode, 403, 'a changed authenticated caller binding fails the final recheck');
  } finally { await fixture.close(); }
});
