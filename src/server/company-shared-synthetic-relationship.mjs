import { canonical, sha256 } from "./relationship-query/aws-http.mjs";
import { documentVersion } from "./relationship-query/graph-assertion-contract.mjs";
import { preparedTextIdentity } from "./relationship-query/prepared-text-binding.mjs";
import { createResolver, stableEntityId, verificationRequestHash } from "./relationship-query/resolver.mjs";
import { queryCompanySharedSyntheticHistories } from "./relationship-query/durable-query.mjs";

const AT = "2026-09-28T00:00:00.000Z";
const EXPIRES = "2099-01-01T00:00:00.000Z";
const PURPOSE = "synthetic-company-shared-contract";
const clone = value => structuredClone(value);
const proof = request => ({ verified: true, request_sha256: verificationRequestHash(request), verifier_id: "synthetic-contract", verifier_version: "1", basis: "fixed synthetic fixture" });
const endpoint = value => ({ display_name: value.toUpperCase(), entity_type: "synthetic_entity", identifier: { namespace: "synthetic-company-shared", scope: "contract-v1", value } });
const citationId = receipt => {
  const { citation_id: _citationId, ...identity } = receipt;
  return `cite_${sha256(canonical(identity))}`;
};

function source(index, subject, object) {
  const text = `Synthetic contract evidence: ${subject.toUpperCase()} depends_on ${object.toUpperCase()}.`;
  const row = { path: `synthetic/company-shared/edge-${index}.txt`, sha256: sha256(`binary:company-shared:${index}`), sidecar: true, enriched: true, enriched_sha256: sha256(`binary:company-shared:${index}`) };
  const document = documentVersion(row, "company_shared");
  const runId = `run_${sha256(`company-shared-synthetic-run:${index}`)}`;
  const binding = {
    schema: "company-shared-synthetic-chunk-binding-v1", run_id: runId, room: "company_shared", source_index: "company-shared-synthetic",
    catalog_manifest_sha256: sha256(`company-shared-synthetic-manifest:${index}`), document_ordinal: 0,
    source_document_version: document.document_version_id, catalog_source_sha256: row.sha256,
    snapshot_id: `txtsnap_${sha256(text)}`, prepared_manifest_sha256: sha256(canonical({ text })),
    sidecar_content_sha256: sha256(text), chunk_ordinal: 0, chunk_sha256: sha256(text),
  };
  const input = { binding, catalog_row: row, prepared_text: text, chunk_start_utf16: 0, chunk_end_utf16: text.length, purpose: PURPOSE };
  const prepared = preparedTextIdentity({ source_binding: binding, purpose: PURPOSE });
  const candidate = {
    subject: `${subject.toUpperCase()}`, predicate: "depends_on", object: `${object.toUpperCase()}`, quote: text,
    state: "candidate", semantic_verified: false, document_version_id: prepared.source_version,
    source_sha256: binding.chunk_sha256, evidence_start_utf16: 0, evidence_end_utf16: text.length,
  };
  const receiptBase = {
    schema: "company-shared-citation-receipt-v1", source_group: "company_shared",
    source_id: sha256(canonical({ fixture: "company-shared-x-y-z-v1", index, document_version_id: document.document_version_id })),
    source_version: `sha256:${binding.chunk_sha256}`,
    provenance_receipt_sha256: sha256(canonical({ fixture: "company-shared-x-y-z-v1", source_document_version: document.document_version_id, source_version: binding.chunk_sha256 })),
  };
  return { input, candidate, receipt: { ...receiptBase, citation_id: citationId(receiptBase) } };
}

export function createCompanySharedSyntheticRelationshipFixture() {
  const edges = [source(1, "x", "y"), source(2, "y", "z")];
  const calls = [];
  const capture = (method, fn) => (...args) => {
    const result = fn(...args);
    calls.push({ method, args: clone(args), result: clone(result) });
    return result;
  };
  const services = {
    callerLane: "cto",
    authorizeSource: capture("authorizeSource", () => ({ allowed: true, provenance: { decision_source: "authenticated_gateway", policy_version: "company-shared-synthetic-v1", allowed_roles: ["cto"] } })),
    isCurrentSource: capture("isCurrentSource", () => true),
    verifyPreparedSource: capture("verifyPreparedSource", proof), verifyIdentity: capture("verifyIdentity", proof),
    verifyRelationship: capture("verifyRelationship", proof), verifySupersession: capture("verifySupersession", proof),
    recordedAt: capture("recordedAt", () => AT),
  };
  const resolver = createResolver(services);
  const events = [];
  for (let index = 0; index < edges.length; index++) {
    const edge = edges[index];
    const sourceRef = resolver.registerSource(edge.input);
    events.push({ operation: "registerSource", input: null, source_index: index, calls: calls.splice(0), output: sourceRef });
    const acceptInput = { candidate: edge.candidate, subject: endpoint(edge.candidate.subject.toLowerCase()), object: endpoint(edge.candidate.object.toLowerCase()), source_ref: sourceRef,
      polarity: "positive", uncertainty: { level: "low", qualifications: ["Synthetic contract evidence only."] } };
    const accepted = resolver.accept(acceptInput);
    events.push({ operation: "accept", input: acceptInput, calls: calls.splice(0), output: accepted });
  }
  const inputs = edges.map(edge => edge.input);
  const history = {
    schema: "resolution-history-v1",
    run: { ref_version: "company-shared-synthetic-run-ref-v1", run_id: inputs[0].binding.run_id, purpose: PURPOSE,
      scope: "company_shared", run_version: "company-shared-synthetic-v1", manifest_sha256: sha256("company-shared-synthetic-manifest") },
    caller_seat: "cto", sources: [], events, queries: [],
  };
  const authorization = { allowed: true, provenance: { decision_source: "authenticated_gateway", policy_version: "company-shared-synthetic-v1", allowed_roles: ["cto"] }, expires_at: EXPIRES };
  const entry = { history, inputs, authorization, sourceCurrent: true, citation_receipts: edges.map(edge => edge.receipt) };
  return { entry, entityIds: { X: stableEntityId(endpoint("x")), Y: stableEntityId(endpoint("y")), Z: stableEntityId(endpoint("z")) } };
}

/** Fixed synthetic acceptance fixture. It does not discover or read company source publications. */
export function createCompanySharedSyntheticRelationshipQuery({ isCurrentCitation } = {}) {
  const fixture = createCompanySharedSyntheticRelationshipFixture();
  const pinned = new Map(fixture.entry.citation_receipts.map(receipt => [receipt.citation_id, canonical(receipt)]));
  const current = isCurrentCitation ?? (receipt => pinned.get(receipt.citation_id) === canonical(receipt));
  return async ({ subject_id, object_id }) => {
    const subject = fixture.entityIds[subject_id], object = fixture.entityIds[object_id];
    if (!subject || !object) throw Object.assign(Error("shared_synthetic_endpoint_invalid"), { code: "shared_synthetic_endpoint_invalid" });
    return queryCompanySharedSyntheticHistories({ entries: [fixture.entry], query: { subject_id: subject, object_id: object }, isCurrentCitation: current });
  };
}
