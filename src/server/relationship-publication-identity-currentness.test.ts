import assert from 'node:assert/strict';
import test from 'node:test';

for (const [key, value] of Object.entries({
  CIO_SITE_ID: 'synthetic',
  CIO_TRACK_KEY: 'synthetic',
  CIO_APP_API_BEARER: 'synthetic',
  PERPLEXITY_CONNECTOR_TOKEN: 'synthetic-placeholder-value-000000000',
  ADMIN_REVOKE_TOKEN: 'synthetic-placeholder-value-000000000',
  N8N_WEBHOOK_SECRET: 'synthetic-placeholder-value-000000000',
})) process.env[key] ??= value;

const enabled = !!process.env.RELATIONSHIP_STORE_MODULE;

test('duplicate identity request hashes combine fail closed regardless of receipt order', async () => {
  const { relationshipPublicationTest } = await import('./relationship-publication.js');
  const requestSha256 = 'a'.repeat(64);
  const proofs = [{ proof: { request_sha256: requestSha256 } }, { proof: { request_sha256: requestSha256 } }];
  for (const decisions of [[{}, null], [null, {}]]) {
    const current = relationshipPublicationTest.identityCurrentnessMap(proofs, decisions);
    assert.equal(current.size, 1);
    assert.equal(current.get(requestSha256), false);
  }
  assert.equal(relationshipPublicationTest.identityCurrentnessMap(proofs, [{}, {}]).get(requestSha256), true);
});

test('candidate query downgrades revoked identities and rejects revocation after its precheck', { skip: !enabled }, async () => {
  const { createAutoPublicationFixture } = await import(new URL('../../tools/relationship-artifacts/auto-publication-fixture.mjs', import.meta.url).href);
  const flags: any = {};
  const fixture = await createAutoPublicationFixture({ flags });
  const post = (body: any) => fixture.routes.app.inject({
    method: 'POST',
    url: '/relationship-publications/v1/synthetic-history/synthetic-reviewer-1/query',
    headers: { authorization: 'Bearer synthetic-history-token-value-1234', 'content-type': 'application/json' },
    payload: JSON.stringify(body),
  });
  try {
    const histories = [];
    for (let index = 0; index < 3; index++) {
      fixture.admit(index);
      const receipt = await fixture.reviewAndPublish(index);
      histories.push({ run_id: fixture.fixtures[index].state.run.run_id, artifact_ref: receipt.artifact_ref });
    }
    const explain = await post({ histories, query: fixture.query });
    assert.equal(explain.statusCode, 200, explain.body);
    assert.equal(explain.json().answer.status, 'qualified');
    assert.equal(Object.hasOwn(explain.json().answer, 'identityProofs'), false);

    flags.identityRevoked = true;
    const candidates = await post({ histories, query: { kind: 'candidate_links', include_stale: true } });
    assert.equal(candidates.statusCode, 200, candidates.body);
    assert.equal(candidates.json().answer.status, 'unverified_candidates');
    assert.ok(candidates.json().answer.items.length > 0);
    assert.ok(candidates.json().answer.items.every((item: any) => item.identity_verified === false && item.accepted === false && item.assertion === null));

    flags.identityRevoked = false;
    flags.identityReads = 0;
    flags.identityRevokeAfterReads = 12;
    const late = await post({ histories, query: { kind: 'candidate_links', include_stale: true } });
    assert.equal(late.statusCode, 403, late.body);
    assert.ok(flags.identityReads > 12);
  } finally {
    await fixture.routes.close();
  }
});
