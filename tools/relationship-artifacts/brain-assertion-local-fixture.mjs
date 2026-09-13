/**
 * Deterministic local durable-history fixture for Brain assertion tests.
 *
 * It records calls made to the gateway's vendored resolver, then exposes the same immutable
 * `{ history, inputs, authorization, sourceCurrent }` entry consumed by durable-query.mjs.
 * No CTO checkout, credential, network, or source text outside this synthetic module is used.
 * Supersession is deliberately same-history only: the paired durable producer rejects a
 * cross-history target/replacement before persistence.
 */
import { createResolver, verificationRequestHash } from '../../src/server/relationship-query/resolver.mjs';
import { canonical, sha256 } from '../../src/server/relationship-query/aws-http.mjs';
import { documentVersion } from '../../src/server/relationship-query/graph-assertion-contract.mjs';
import { preparedTextIdentity } from '../../src/server/relationship-query/prepared-text-binding.mjs';
import { planGraphCatalogPage } from '../../src/server/graph-catalog-planner.ts';
import { graphCatalogControllerTest } from '../../src/server/graph-catalog-controller.ts';
import { createRelationshipPublicationDiscoveryService } from '../../src/server/relationship-publication.ts';
import { registerRelationshipPublicationRoutes } from '../../src/server/relationship-publication.ts';
import { resolveCompanyGraphScope } from '../../src/server/company-graph-scope.ts';
import Fastify from 'fastify';

const AT = '2026-09-13T12:00:00.000Z';
const LATER = '2026-09-13T12:01:00.000Z';
const clone = value => structuredClone(value);
const proof = request => ({ verified: true, request_sha256: verificationRequestHash(request), verifier_id: 'local-synthetic-verifier', verifier_version: '1', basis: 'exact synthetic witness' });

function endpoint(type, value) {
  return { display_name: value, entity_type: type, identifier: { namespace: `local-${type}`, scope: 'fixture', value } };
}

function source(runSeed, text) {
  const row = { path: `synthetic/${runSeed}.txt`, sha256: sha256(`binary:${runSeed}`), sidecar: true, enriched: true, enriched_sha256: sha256(`binary:${runSeed}`) };
  const document = documentVersion(row, 'finance');
  const runId = `run_${sha256(`run:${runSeed}`)}`;
  const binding = {
    schema: 'cfo-prepared-chunk-binding-v1', run_id: runId, room: 'finance', source_index: 'finance-cfo-source-docs',
    catalog_manifest_sha256: sha256(`manifest:${runSeed}`), document_ordinal: 0, source_document_version: document.document_version_id,
    catalog_source_sha256: row.sha256, snapshot_id: `txtsnap_${sha256(text)}`, prepared_manifest_sha256: sha256(canonical({ text })),
    sidecar_content_sha256: sha256(text), chunk_ordinal: 0, chunk_sha256: sha256(text),
  };
  return { row, runId, value: { binding, catalog_row: row, prepared_text: text, chunk_start_utf16: 0, chunk_end_utf16: text.length, purpose: 'synthetic-resolution' } };
}

function recorder() {
  let calls = [], recordedAt = AT;
  const call = (method, fn) => (...args) => {
    const result = fn(...args);
    calls.push({ method, args: clone(args), result: clone(result) });
    return result;
  };
  const services = {
    callerLane: 'cfo',
    authorizeSource: call('authorizeSource', () => ({ allowed: true, provenance: { decision_source: 'authenticated_gateway', policy_version: 'local-fixture-v1', allowed_roles: ['cfo'] } })),
    isCurrentSource: call('isCurrentSource', () => true),
    verifyPreparedSource: call('verifyPreparedSource', proof), verifyIdentity: call('verifyIdentity', proof),
    verifyRelationship: call('verifyRelationship', proof), verifySupersession: call('verifySupersession', proof),
    recordedAt: call('recordedAt', () => recordedAt),
  };
  return { services, setRecordedAt: value => { recordedAt = value; }, take: () => { const out = calls; calls = []; return out; } };
}

/** Returns one immutable, replayable history entry and its accepted typed claim. */
export function createLocalBrainAssertionFixture({ supersede = false } = {}) {
  const first = source('first', 'P-001 depends on I-001.');
  const second = source('second', 'P-001 depends on I-001. replacement evidence.');
  const trace = recorder();
  const resolver = createResolver(trace.services);
  const firstRef = resolver.registerSource(first.value);
  const registerFirst = { operation: 'registerSource', input: null, source_index: 0, calls: trace.take(), output: firstRef };
  const candidate = value => ({ subject: 'P-001', predicate: 'depends_on', object: 'I-001', quote: 'P-001 depends on I-001.', state: 'candidate', semantic_verified: false, document_version_id: preparedTextIdentity({ source_binding: value.binding, purpose: value.purpose }).source_version, source_sha256: value.binding.chunk_sha256, evidence_start_utf16: 0, evidence_end_utf16: 'P-001 depends on I-001.'.length });
  const accept = value => resolver.accept({ candidate: candidate(value), subject: endpoint('payment', 'P-001'), object: endpoint('invoice', 'I-001'), source_ref: value === first.value ? firstRef : secondRef, polarity: 'positive', uncertainty: { level: 'low', qualifications: [] } });
  const original = accept(first.value);
  const acceptFirst = { operation: 'accept', input: { candidate: candidate(first.value), subject: endpoint('payment', 'P-001'), object: endpoint('invoice', 'I-001'), source_ref: firstRef, polarity: 'positive', uncertainty: { level: 'low', qualifications: [] } }, calls: trace.take(), output: original };
  let secondRef, events = [registerFirst, acceptFirst], replacement = null, correction = null;
  if (supersede) {
    secondRef = resolver.registerSource(second.value);
    events.push({ operation: 'registerSource', input: null, source_index: 1, calls: trace.take(), output: secondRef });
    replacement = accept(second.value);
    events.push({ operation: 'accept', input: { candidate: candidate(second.value), subject: endpoint('payment', 'P-001'), object: endpoint('invoice', 'I-001'), source_ref: secondRef, polarity: 'positive', uncertainty: { level: 'low', qualifications: [] } }, calls: trace.take(), output: replacement });
    // The resolver requires a later trusted clock for supersession.
    trace.setRecordedAt(LATER);
    correction = resolver.supersede({ target_id: original.record_id, replacement_id: replacement.record_id });
    events.push({ operation: 'supersede', input: { target_id: original.record_id, replacement_id: replacement.record_id }, calls: trace.take(), output: correction });
  }
  const history = { schema: 'resolution-history-v1', run: { ref_version: 'neptune-trial-active-run-ref-v1', run_id: first.runId, purpose: 'synthetic-resolution', scope: 'finance', run_version: 'local-fixture-v1', manifest_sha256: sha256('local-manifest') }, caller_seat: 'cfo', sources: [], events, queries: [] };
  const entry = { history, inputs: supersede ? [first.value, second.value] : [first.value], authorization: { allowed: true, provenance: { decision_source: 'authenticated_gateway', policy_version: 'local-fixture-v1', allowed_roles: ['cfo'] }, expires_at: '2027-01-01T00:00:00.000Z' }, sourceCurrent: true };
  return { entry, original, replacement, correction };
}

/*
 * This is intentionally a transport fixture, not a shortcut around historical-read.
 * The service receives byte-exact pinned admission/proposal records, immutable artifact
 * envelopes, a current catalog, and identity revalidation.  It therefore exercises the
 * production assertionRecords admission, artifact, source-currentness, replay, and
 * projection path without a paired private repository or network credentials.
 */
const fixtureHash = value => sha256(canonical(value));
const artifactRef = (payload, version_id) => {
  const payload_sha256 = fixtureHash(payload);
  return {
    schema: 'relationship-resolution-artifact-ref-v1', artifact_id: `resart_${payload_sha256}`,
    bucket: 'otchealth-finance-legal-dr-55c84f6b',
    key: `resolution-artifacts/sha256/${payload_sha256.slice(0, 2)}/${payload_sha256}.json`,
    payload_sha256, version_id, size_bytes: Buffer.byteLength(canonical(payload)),
  };
};
const pinnedRef = (key, value, version_id) => ({ key, version_id, sha256: sha256(Buffer.from(canonical(value))) });
const response = (body, version_id, run, producer) => ({
  status: 200,
  headers: new Headers({
    'x-amz-version-id': version_id,
    ...(run ? { 'x-amz-meta-resolution-run': run.run_id, 'x-amz-meta-resolution-producer': producer, 'x-amz-server-side-encryption': 'AES256' } : {}),
  }),
  body: Buffer.from(canonical(body)),
});

/**
 * Offline, fully injected assertionRecords service fixture.
 * `input` and `context` are ready for service tests.  `expected` is the accepted typed
 * assertion that must be present in the service result.  Cross-history correction is
 * intentionally unavailable: the paired durable contract rejects it before persist.
 */
export function createLocalBrainAssertionServiceFixture({ sourceCurrent = true, identityCurrent = true, policyChange = false, artifactVersionMismatch = false, tamperedReceipt = false, tamperedHistoryEvent = false, exactValidTime = false } = {}) {
  const caller_hash = sha256('local-fixture-caller');
  const cohort_id = 'local-fixture';
  const producer_id = 'synthetic-reviewer-1';
  const catalog_source_sha256 = sha256('local-fixture-catalog');
  const row = { path: 'synthetic/assertion-source.txt', sha256: sha256('local-fixture-source'), sidecar: true, enriched: true, enriched_sha256: sha256('local-fixture-source') };
  const config = {
    cohort_id, catalog_key: 'graph-trial/local-fixture/catalog.jsonl', catalog_source_sha256,
    source_prefixes: ['synthetic/'], purpose: 'synthetic-resolution', run_version: 'local-fixture-v1',
    batch_size: 1, max_admissions: 1, policy_sha256: sha256('local-fixture-policy'),
    expires_at: '2027-01-01T00:00:00.000Z',
  };
  const catalog = { rows: [row], catalogEtag: 'local-fixture-etag', catalogSourceSha256: catalog_source_sha256, createdAt: AT };
  const scope = resolveCompanyGraphScope('cfo', 'finance');
  if (!scope.ok) throw Error('fixture_scope_missing');
  const planned = planGraphCatalogPage({ ...catalog, scope: scope.scope, limit: 1 });
  if (!planned.page.manifest) throw Error('fixture_manifest_missing');
  const proposal = graphCatalogControllerTest.proposal(config, catalog, planned.page.manifest);
  const run = proposal.run;
  const text = 'P-001 depends on I-001.';
  const binding = {
    schema: 'cfo-prepared-chunk-binding-v1', run_id: run.run_id, room: 'finance', source_index: 'finance-cfo-source-docs',
    catalog_manifest_sha256: run.manifest_sha256, document_ordinal: 0,
    source_document_version: proposal.manifest.documents[0].document_version_id,
    catalog_source_sha256: proposal.manifest.documents[0].source_version,
    snapshot_id: `txtsnap_${sha256('local-fixture-snapshot')}`, prepared_manifest_sha256: sha256(canonical({ text })),
    sidecar_content_sha256: sha256(text), chunk_ordinal: 0, chunk_sha256: sha256(text),
  };
  const sourceInput = { binding, catalog_row: row, prepared_text: text, chunk_start_utf16: 0, chunk_end_utf16: text.length, purpose: run.purpose };
  const trace = recorder();
  const resolver = createResolver(trace.services);
  const source_ref = resolver.registerSource(sourceInput);
  const registration = { operation: 'registerSource', input: null, source_index: 0, calls: trace.take(), output: source_ref };
  const candidate = { subject: 'P-001', predicate: 'depends_on', object: 'I-001', quote: text, state: 'candidate', semantic_verified: false, document_version_id: preparedTextIdentity({ source_binding: binding, purpose: run.purpose }).source_version, source_sha256: binding.chunk_sha256, evidence_start_utf16: 0, evidence_end_utf16: text.length };
  const valid_time = exactValidTime ? { valid_from: '2026-09-13T11:00:00.000Z', valid_to: '2026-09-13T13:00:00.000Z', valid_from_basis: 'exact_witness', valid_to_basis: 'exact_witness' } : undefined;
  const acceptInput = { candidate, subject: endpoint('payment', 'P-001'), object: endpoint('invoice', 'I-001'), source_ref, polarity: 'positive', uncertainty: { level: 'low', qualifications: [] }, ...(valid_time ? { valid_time } : {}) };
  const accepted = resolver.accept(acceptInput);
  const acceptance = { operation: 'accept', input: acceptInput, calls: trace.take(), output: accepted };
  const sourcePayload = { schema: 'resolution-source-input-v1', run, input: sourceInput };
  const sourceArtifactRef = artifactRef(sourcePayload, 'v-source-1');
  const historyPayload = { schema: 'resolution-history-v1', run, caller_seat: 'cfo', sources: [sourceArtifactRef], events: [registration, acceptance], queries: [] };
  const historyArtifactRef = artifactRef(historyPayload, 'v-history-1');
  const unsignedAdmission = { allowed: true, key: proposal.key, run_id: run.run_id, manifest_sha256: run.manifest_sha256, max_documents: 1, policy_sha256: config.policy_sha256 };
  const admission = { ...unsignedAdmission, decision_sha256: fixtureHash(unsignedAdmission) };
  const admissionRef = pinnedRef(`graph-trial/20260908/catalog-cohorts/${cohort_id}/server/admissions/${run.run_id}.json`, admission, 'v-admission-1');
  const proposalRef = pinnedRef(`graph-trial/20260908/catalog-cohorts/${cohort_id}/server/proposals/${proposal.key}.json`, proposal, 'v-proposal-1');
  const policy = { schema: 'relationship-publication-policy-v1', policy_version: 'local-fixture-v1', expires_at: '2027-01-01T00:00:00.000Z', bindings: [{ authenticated_caller: 'cfo', caller_hash, producer_id, cohort_id, purpose: run.purpose, run_version: run.run_version, encryption: { algorithm: 'AES256' }, source_policy: { catalog_key: config.catalog_key, catalog_source_sha256, source_prefixes: config.source_prefixes } }] };
  const grant = { schema: 'relationship-publication-grant-v1', cohort_id, producer_id, caller_hash, run, admission: admissionRef, proposal: proposalRef, artifact_ref: historyArtifactRef, approved_artifacts: [historyArtifactRef, sourceArtifactRef].map(ref => ({ digest: ref.payload_sha256, version_id: ref.version_id })), issued_under_policy_version: 'local-fixture-v1' };
  const storedGrant = tamperedReceipt ? { ...grant, admission: { ...grant.admission, sha256: '0'.repeat(64) } } : grant;
  const objects = new Map([
    [admissionRef.key, response(admission, admissionRef.version_id)],
    [proposalRef.key, response(proposal, proposalRef.version_id)],
    [`graph-trial/20260908/workers/cfo/${run.run_id}/relationship-producers/${producer_id}/resolution-artifacts/sha256/${sourceArtifactRef.payload_sha256.slice(0, 2)}/${sourceArtifactRef.payload_sha256}.json`, response({ schema: 'relationship-resolution-artifact-v1', payload_sha256: sourceArtifactRef.payload_sha256, payload: sourcePayload }, sourceArtifactRef.version_id, run, producer_id)],
    [`graph-trial/20260908/workers/cfo/${run.run_id}/relationship-producers/${producer_id}/resolution-artifacts/sha256/${historyArtifactRef.payload_sha256.slice(0, 2)}/${historyArtifactRef.payload_sha256}.json`, response({ schema: 'relationship-resolution-artifact-v1', payload_sha256: historyArtifactRef.payload_sha256, payload: historyPayload }, historyArtifactRef.version_id, run, producer_id)],
  ]);
  if (artifactVersionMismatch) {
    const key = `graph-trial/20260908/workers/cfo/${run.run_id}/relationship-producers/${producer_id}/resolution-artifacts/sha256/${historyArtifactRef.payload_sha256.slice(0, 2)}/${historyArtifactRef.payload_sha256}.json`;
    const value = objects.get(key);
    objects.set(key, { ...value, headers: new Headers({ ...Object.fromEntries(value.headers), 'x-amz-version-id': 'v-history-other' }) });
  }
  if (tamperedHistoryEvent) {
    const key = `graph-trial/20260908/workers/cfo/${run.run_id}/relationship-producers/${producer_id}/resolution-artifacts/sha256/${historyArtifactRef.payload_sha256.slice(0, 2)}/${historyArtifactRef.payload_sha256}.json`;
    const value = objects.get(key);
    const envelope = JSON.parse(value.body.toString('utf8'));
    envelope.payload.events[1].output.candidate.predicate = 'tampered_predicate';
    objects.set(key, { ...value, body: Buffer.from(canonical(envelope)) });
  }
  const state = { sourceCurrent, identityCurrent, policyChange, policyReads: 0, identityReads: 0, sourceReads: 0,
    authenticated: true, callerHash: caller_hash, authChecks: 0, revokeAuthAfterChecks: null, changeCallerHashAfterChecks: null };
  const context = { caller_agent: 'cfo', caller_hash, connector_surface: true, raw_token: 'local-fixture-token', m365_static_auth: false };
  const deps = {
    // This is a synthetic boundary, but it deliberately authenticates the actual Fastify request
    // rather than handing routes ambient trust.  Tests can revoke or change the caller only after
    // the initial request authentication to exercise the route's final recheck.
    authenticate: async (request) => {
      state.authChecks++;
      const authorization = request?.headers?.authorization;
      if (!state.authenticated || authorization !== `Bearer ${context.raw_token}` ||
        (state.revokeAuthAfterChecks !== null && state.authChecks > state.revokeAuthAfterChecks)) return undefined;
      const currentHash = state.changeCallerHashAfterChecks !== null && state.authChecks > state.changeCallerHashAfterChecks
        ? sha256('local-fixture-late-caller') : state.callerHash;
      return { ...context, caller_hash: currentHash };
    },
    now: () => Date.parse(AT), policyJson: () => canonical(state.policyChange && state.policyReads++ > 0 ? { ...policy, policy_version: 'local-fixture-v2' } : policy),
    storeFor: () => ({ get: async () => ({ found: true, body: Buffer.from(canonical(storedGrant)), versionId: 'v-grant-1' }), putCreateOnly: async () => { throw Error('fixture_unexpected_write'); }, list: async () => ({ records: [] }) }),
    readVersion: async ({ key, versionId }) => { const value = objects.get(key); if (!value || value.headers.get('x-amz-version-id') !== versionId) throw Error('fixture_version_mismatch'); return value; },
    readCatalog: async () => [row], checkSource: async () => state.sourceCurrent === 'late' ? state.sourceReads++ === 0 : state.sourceCurrent,
    identityCurrentness: { revalidate: async (_request, previousProof) => state.identityCurrent === 'late' ? state.identityReads++ === 0 ? structuredClone(previousProof) : null : state.identityCurrent ? structuredClone(previousProof) : null },
  };
  const service = createRelationshipPublicationDiscoveryService(deps);
  const input = { cohort_id, producer_id, histories: [{ run_id: run.run_id, artifact_ref: historyArtifactRef }] };
  return { service, deps, input, context, expected: accepted, artifacts: { historyArtifactRef, sourceArtifactRef }, state, limitation: 'cross_history_supersession_rejected_by_paired_durable_contract' };
}

/** Self-contained authenticated Fastify surface over the same durable replay fixture. */
export async function createLocalBrainAssertionRouteFixture(options = {}) {
  const fixture = createLocalBrainAssertionServiceFixture(options);
  const app = Fastify();
  registerRelationshipPublicationRoutes(app, fixture.deps);
  await app.ready();
  return { app, input: fixture.input, context: fixture.context, expected: fixture.expected, state: fixture.state,
    close: async () => app.close() };
}
