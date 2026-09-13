import test from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { createAutoPublicationFixture } from './auto-publication-fixture.mjs';
import { createReviewHistoryAuthority } from './review-history-authority.mjs';

test('corporate history authority rejects personal and unknown scopes before transport', () => {
  for (const scope of ['legal_personal', 'unknown', 'finance']) {
    assert.throws(() => createReviewHistoryAuthority({run:{run_id:'run_'+'a'.repeat(64),scope},callerSeat:'clo',producer:'synthetic',getAuthorization:async()=>{throw Error('transport must not run');}}), /relationship_authority_configuration/);
  }
});

const ctoRoot = process.env.RELATIONSHIP_CTO_ROOT;
for (const [name, value] of Object.entries({
  CIO_SITE_ID: 'synthetic', CIO_TRACK_KEY: 'synthetic', CIO_APP_API_BEARER: 'synthetic',
  PERPLEXITY_CONNECTOR_TOKEN: 'synthetic-fixture-only-not-a-real-token-0001',
  ADMIN_REVOKE_TOKEN: 'synthetic-fixture-only-not-a-real-token-0002',
  N8N_WEBHOOK_SECRET: 'synthetic-fixture-only-not-a-real-secret-0003',
})) process.env[name] ??= value;

test('corporate CLO publishes and retrieves a synthetic legal-company history through the gateway routes', { skip: !ctoRoot }, async () => {
  const prior = process.env.RELATIONSHIP_STORE_MODULE;
  process.env.RELATIONSHIP_STORE_MODULE = join(resolve(ctoRoot), 'tools/neptune-trial/relationship-adapters/s3-resolution-store.mjs');
  const fixture = await createAutoPublicationFixture({ callerSeat: 'clo' });
  try {
    fixture.admit(0);
    const publication = await fixture.reviewAndPublish(0);
    assert.equal(publication.run.scope, 'legal_company');
    const retrieved = await fixture.host.retrievePage(fixture.query);
    assert.equal(retrieved.page.items.length, 1);
    assert.equal(fixture.state.callerSeat, 'clo');
    assert.ok(['unsupported', 'qualified', 'invalidated'].includes(retrieved.recall.answer.status));
  } finally {
    await fixture.routes.close();
    if (prior === undefined) delete process.env.RELATIONSHIP_STORE_MODULE;
    else process.env.RELATIONSHIP_STORE_MODULE = prior;
  }
});

test('corporate CLO publication refuses a personal caller before a grant is issued', { skip: !ctoRoot }, async () => {
  const prior = process.env.RELATIONSHIP_STORE_MODULE;
  process.env.RELATIONSHIP_STORE_MODULE = join(resolve(ctoRoot), 'tools/neptune-trial/relationship-adapters/s3-resolution-store.mjs');
  const fixture = await createAutoPublicationFixture({ callerSeat: 'clo', flags: { callerAgent: 'clo-personal' } });
  try {
    fixture.admit(0);
    await fixture.review(0);
    await assert.rejects(fixture.publish(0), /paged_recall_forbidden|paged_recall_unavailable/);
    assert.equal(Object.keys(fixture.state.grants).length, 0);
  } finally {
    await fixture.routes.close();
    if (prior === undefined) delete process.env.RELATIONSHIP_STORE_MODULE;
    else process.env.RELATIONSHIP_STORE_MODULE = prior;
  }
});
