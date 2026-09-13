import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';

for (const [key, value] of Object.entries({ CIO_SITE_ID: 'synthetic', CIO_TRACK_KEY: 'synthetic', CIO_APP_API_BEARER: 'synthetic', PERPLEXITY_CONNECTOR_TOKEN: 'synthetic-placeholder-value-000000000', ADMIN_REVOKE_TOKEN: 'synthetic-placeholder-value-000000000', N8N_WEBHOOK_SECRET: 'synthetic-placeholder-value-000000000' })) process.env[key] ??= value;
const repoRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const pairedStore = join(repoRoot, '..', 'otchealth-cto', 'tools', 'neptune-trial', 'relationship-adapters', 's3-resolution-store.mjs');
if (!process.env.RELATIONSHIP_STORE_MODULE && existsSync(pairedStore)) process.env.RELATIONSHIP_STORE_MODULE = pairedStore;
const enabled = !!process.env.RELATIONSHIP_STORE_MODULE;

test('assertionRecords reuses publication authority and returns no source text', { skip: !enabled }, async () => {
  const { createAutoPublicationFixture } = await import(new URL('../../tools/relationship-artifacts/auto-publication-fixture.mjs', import.meta.url).href);
  const flags: any = {}, fixture = await createAutoPublicationFixture({ flags });
  try {
    fixture.admit(0); const receipt = await fixture.reviewAndPublish(0);
    const input = { cohort_id: 'synthetic-history', producer_id: 'synthetic-reviewer-1', histories: [{ run_id: fixture.fixtures[0].state.run.run_id, artifact_ref: receipt.artifact_ref }] };
    const batch = await fixture.routes.service.assertionRecords(input, fixture.routes.ctx, new AbortController().signal);
    assert.equal(batch.length, 1);
    assert.ok(batch[0]!.assertions.length > 0, 'a real accepted semantic receipt must yield an assertion');
    const assertion = batch[0]!.assertions[0]!;
    assert.equal(assertion.status, 'verified');
    assert.match(assertion.statement, /^typed relationship: [a-z0-9_:-]+ [a-z0-9_.:-]+ [a-z0-9_:-]+$/);
    assert.match(assertion.recordedAt, /^2026-09-08T06:00:00\.000Z$/);
    assert.deepEqual(assertion.validTime, { basis: 'unknown', start: null, end: null });
    assert.equal(assertion.evidence[0]!.immutableVersion, assertion.evidence[0]!.contentSha256);
    assert.deepEqual(assertion.evidence[0]!.span, { offsetUnit: 'bytes', start: 0, end: 25 });
    assert.equal(JSON.stringify(batch).includes('prepared_text'), false);
    assert.equal(JSON.stringify(batch).includes('Synthetic'), false);
  } finally { await fixture.routes.close(); }
});

test('assertionRecords fails closed for source revocation, cross-scope, policy race and artifact mismatch', { skip: !enabled }, async () => {
  const { createAutoPublicationFixture } = await import(new URL('../../tools/relationship-artifacts/auto-publication-fixture.mjs', import.meta.url).href);
  const flags: any = {}, fixture = await createAutoPublicationFixture({ flags });
  try {
    fixture.admit(0); const receipt = await fixture.reviewAndPublish(0);
    const base = { cohort_id: 'synthetic-history', producer_id: 'synthetic-reviewer-1', histories: [{ run_id: fixture.fixtures[0].state.run.run_id, artifact_ref: receipt.artifact_ref }] };
    flags.deniedSource = true;
    await assert.rejects(fixture.routes.service.assertionRecords(base, fixture.routes.ctx, new AbortController().signal));
    flags.deniedSource = false;
    await assert.rejects(fixture.routes.service.assertionRecords({ ...base, histories: [base.histories[0]!, base.histories[0]!] }, fixture.routes.ctx, new AbortController().signal));
    await assert.rejects(fixture.routes.service.assertionRecords({ ...base, scope: 'legal_company' }, fixture.routes.ctx, new AbortController().signal));
    await assert.rejects(fixture.routes.service.assertionRecords({ ...base, histories: [{ ...base.histories[0], artifact_ref: { ...receipt.artifact_ref, version_id: 'wrong-version' } }] }, fixture.routes.ctx, new AbortController().signal));
    await assert.rejects(fixture.routes.service.assertionRecords(base, fixture.routes.ctx, new AbortController().signal, async () => { fixture.state.publicationPolicy.policy_version = 'policy-raced'; }));
    fixture.state.publicationPolicy.policy_version = 'synthetic-cohort-v1';
    flags.identityRevoked = true;
    await assert.rejects(fixture.routes.service.assertionRecords(base, fixture.routes.ctx, new AbortController().signal));
    flags.identityRevoked = false;
    flags.sourceChecks = 0;
    await fixture.routes.service.assertionRecords(base, fixture.routes.ctx, new AbortController().signal);
    const checksBeforeLateRevocation = flags.sourceChecks;
    flags.sourceChecks = 0;
    flags.revokeAfterChecks = checksBeforeLateRevocation - 1;
    await assert.rejects(fixture.routes.service.assertionRecords(base, fixture.routes.ctx, new AbortController().signal));
    delete flags.revokeAfterChecks;
    const artifactKey = Object.keys(fixture.state.objects).find(key => key.includes(receipt.artifact_ref.payload_sha256));
    assert.ok(artifactKey);
    const originalArtifact = fixture.state.objects[artifactKey]!.body;
    const tampered = JSON.parse(Buffer.from(originalArtifact, 'base64').toString('utf8'));
    tampered.payload.events.find((event: any) => event.operation === 'accept').output.assertion.semantic_intent.support.verifier_id = 'tampered-verifier';
    fixture.state.objects[artifactKey]!.body = Buffer.from(JSON.stringify(tampered)).toString('base64');
    await assert.rejects(fixture.routes.service.assertionRecords(base, fixture.routes.ctx, new AbortController().signal));
    fixture.state.objects[artifactKey]!.body = originalArtifact;
  } finally { await fixture.routes.close(); }
});

test('durable review rejects a cross-history supersession before publication', { skip: !enabled }, async () => {
  const { createAutoPublicationFixture } = await import(new URL('../../tools/relationship-artifacts/auto-publication-fixture.mjs', import.meta.url).href);
  const fixture = await createAutoPublicationFixture({ flags: {} });
  try {
    fixture.admit(0); const first = await fixture.review(0);
    fixture.admit(1);
    await assert.rejects(
      fixture.review(1, { crossHistoryTargetId: first.records[0]!.record_id }),
      (error: any) => error?.code === 'resolution_batch_invalid',
    );
  } finally { await fixture.routes.close(); }
});
