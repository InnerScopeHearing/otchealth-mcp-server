import assert from "node:assert/strict";
import test from "node:test";
import { canonical, sha256 } from "./aws-http.mjs";
import { documentVersion } from "./graph-assertion-contract.mjs";
import { preparedTextIdentity } from "./prepared-text-binding.mjs";
import { bindPreparedSource, createResolver, verificationRequestHash } from "./resolver.mjs";

const proof = request => ({ verified: true, request_sha256: verificationRequestHash(request), verifier_id: "synthetic", verifier_version: "1", basis: "synthetic exact witness" });
const endpoint = (entity_type, value) => ({ display_name: value, entity_type, identifier: { namespace: `synthetic-${entity_type}`, scope: "test", value } });
function fixture(text) {
  const row = { path: "synthetic/source.pdf", sha256: sha256("binary"), sidecar: true, enriched: true, enriched_sha256: sha256("binary") };
  const document = documentVersion(row, "finance");
  const binding = { schema: "cfo-prepared-chunk-binding-v1", run_id: `run_${sha256("run")}`, room: "finance", source_index: "finance-cfo-source-docs",
    catalog_manifest_sha256: sha256("catalog"), document_ordinal: 0, source_document_version: document.document_version_id, catalog_source_sha256: row.sha256,
    snapshot_id: `txtsnap_${sha256(text)}`, prepared_manifest_sha256: sha256(canonical({ text })), sidecar_content_sha256: sha256(text), chunk_ordinal: 0, chunk_sha256: sha256(text) };
  const source = { binding, catalog_row: row, prepared_text: text, chunk_start_utf16: 0, chunk_end_utf16: text.length, purpose: "synthetic-resolution" };
  const identity = preparedTextIdentity({ source_binding: binding, purpose: source.purpose });
  const services = { callerLane: "cfo", authorizeSource: () => ({ allowed: true, provenance: { decision_source: "authenticated_gateway", policy_version: "synthetic-v1", allowed_roles: ["cfo"] } }),
    isCurrentSource: () => true, verifyPreparedSource: proof, verifyIdentity: proof, verifyRelationship: proof,
    recordedAt: () => "2026-09-11T00:00:00.000Z" };
  const quote = "P-001 depends on I-001.", candidate = { subject: "P-001", predicate: "depends_on", object: "I-001", quote, state: "candidate", semantic_verified: false,
    document_version_id: identity.source_version, source_sha256: binding.chunk_sha256, evidence_start_utf16: text.lastIndexOf(quote), evidence_end_utf16: text.length };
  return { source, candidate, services, subject: endpoint("payment", "P-001"), object: endpoint("invoice", "I-001") };
}

test("accepts the selected second occurrence of a repeated quote", () => {
  const quote = "P-001 depends on I-001.", f = fixture(`${quote}\n${quote}`), resolver = createResolver(f.services), source_ref = resolver.registerSource(f.source);
  const record = resolver.accept({ candidate: f.candidate, subject: f.subject, object: f.object, source_ref, polarity: "positive", uncertainty: { level: "low", qualifications: [] } });
  assert.equal(record.evidence.text_start_utf16, quote.length + 1);
});

test("rejects candidates missing selected UTF-16 offsets", () => {
  const quote = "P-001 depends on I-001.", f = fixture(quote), resolver = createResolver(f.services), source_ref = resolver.registerSource(f.source);
  delete f.candidate.evidence_start_utf16; delete f.candidate.evidence_end_utf16;
  assert.throws(() => resolver.accept({ candidate: f.candidate, subject: f.subject, object: f.object, source_ref, polarity: "positive", uncertainty: { level: "low", qualifications: [] } }), error => error.code === "candidate_span_invalid");
});

test("prepared binding still rejects a tampered selected span", () => {
  const quote = "P-001 depends on I-001.", f = fixture(quote), bound = bindPreparedSource(f.source);
  assert.equal(bound.text, quote);
  f.candidate.evidence_start_utf16 = 1;
  const resolver = createResolver(f.services), source_ref = resolver.registerSource(f.source);
  assert.throws(() => resolver.accept({ candidate: f.candidate, subject: f.subject, object: f.object, source_ref, polarity: "positive", uncertainty: { level: "low", qualifications: [] } }), error => error.code === "candidate_span_invalid");
});
