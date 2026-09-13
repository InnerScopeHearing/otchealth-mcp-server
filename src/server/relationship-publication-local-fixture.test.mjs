import assert from 'node:assert/strict';
import test from 'node:test';

// The fixture imports the production service.  Keep the normal synthetic test-only
// configuration in place before its dynamic import, exactly as the service tests do.
for (const [key, value] of Object.entries({
  CIO_SITE_ID: 'synthetic', CIO_TRACK_KEY: 'synthetic', CIO_APP_API_BEARER: 'synthetic',
  PERPLEXITY_CONNECTOR_TOKEN: 'synthetic-placeholder-value-000000000',
  ADMIN_REVOKE_TOKEN: 'synthetic-placeholder-value-000000000',
  N8N_WEBHOOK_SECRET: 'synthetic-placeholder-value-000000000',
})) process.env[key] ??= value;

test('local durable artifact fixture reaches assertionRecords with a nonempty verified typed claim', async () => {
  const { createLocalBrainAssertionServiceFixture } = await import(new URL('../../tools/relationship-artifacts/brain-assertion-local-fixture.mjs', import.meta.url).href);
  const fixture = createLocalBrainAssertionServiceFixture();
  const records = await fixture.service.assertionRecords(fixture.input, fixture.context, new AbortController().signal);
  assert.equal(records.length, 1);
  assert.equal(records[0].runId, fixture.input.histories[0].run_id);
  assert.equal(records[0].assertions.length, 1);
  const [assertion] = records[0].assertions;
  assert.equal(assertion.contractVersion, 'brain.contract.v1');
  assert.equal(assertion.status, 'verified');
  assert.equal(assertion.lifecycle, 'active');
  assert.match(assertion.statement, / depends_on /);
  assert.equal(assertion.evidence.length, 1);
  assert.equal(fixture.limitation, 'cross_history_supersession_rejected_by_paired_durable_contract');
});

async function rejects(options, mutate = value => value) {
  const { createLocalBrainAssertionServiceFixture } = await import(new URL('../../tools/relationship-artifacts/brain-assertion-local-fixture.mjs', import.meta.url).href);
  const fixture = createLocalBrainAssertionServiceFixture(options);
  const { input = fixture.input, context = fixture.context } = mutate(fixture);
  await assert.rejects(() => fixture.service.assertionRecords(input, context, new AbortController().signal));
}

test('assertionRecords fails closed when a source is already revoked', async () => {
  await rejects({ sourceCurrent: false });
});

test('assertionRecords fails closed when a source is revoked during replay', async () => {
  await rejects({ sourceCurrent: 'late' });
});

test('assertionRecords fails closed when identity proof is already or later revoked', async () => {
  await rejects({ identityCurrent: false });
  await rejects({ identityCurrent: 'late' });
});

test('assertionRecords rejects foreign caller and caller-selected foreign scope', async () => {
  await rejects({}, fixture => ({ context: { ...fixture.context, caller_hash: 'f'.repeat(64) } }));
  await rejects({}, fixture => ({ input: { ...fixture.input, scope: 'legal_company' } }));
});

test('assertionRecords enforces pinned artifact version and digest', async () => {
  await rejects({ artifactVersionMismatch: true });
  await rejects({ tamperedHistoryEvent: true });
  await rejects({}, fixture => ({ input: { ...fixture.input, histories: [{ ...fixture.input.histories[0], artifact_ref: { ...fixture.input.histories[0].artifact_ref, payload_sha256: 'a'.repeat(64), artifact_id: `resart_${'a'.repeat(64)}`, key: `resolution-artifacts/sha256/aa/${'a'.repeat(64)}.json` } }] } }));
});

test('assertionRecords rejects duplicate history and tampered pinned receipt', async () => {
  await rejects({}, fixture => ({ input: { ...fixture.input, histories: [fixture.input.histories[0], fixture.input.histories[0]] } }));
  await rejects({ tamperedReceipt: true });
});

test('assertionRecords rejects a policy that changes while replay is in progress', async () => {
  await rejects({ policyChange: true });
});
