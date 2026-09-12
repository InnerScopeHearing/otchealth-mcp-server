import { canonical, sha256 } from "./aws-http.mjs";

export const PREPARED_TEXT_BINDING_SCHEMA = "cfo-prepared-chunk-binding-v1";
export const PREPARED_TEXT_SOURCE_SCHEMA = "cfo-prepared-chunk-source-v1";
export const COMPANY_PREPARED_TEXT_BINDING_SCHEMA = "company-prepared-chunk-binding-v1";
export const COMPANY_PREPARED_TEXT_SOURCE_SCHEMA = "company-prepared-chunk-source-v1";

const HASH_RE = /^[a-f0-9]{64}$/;
const RUN_ID_RE = /^run_[a-f0-9]{64}$/;
const SOURCE_VERSION_RE = /^docv_[a-f0-9]{64}$/;
const SNAPSHOT_ID_RE = /^txtsnap_[a-f0-9]{64}$/;
const PURPOSE_RE = /^[a-z][a-z0-9_.:-]{0,119}$/;
const BINDING_KEYS = Object.freeze([
  "catalog_manifest_sha256",
  "catalog_source_sha256",
  "chunk_ordinal",
  "chunk_sha256",
  "document_ordinal",
  "prepared_manifest_sha256",
  "room",
  "run_id",
  "schema",
  "sidecar_content_sha256",
  "snapshot_id",
  "source_document_version",
  "source_index"
].sort());
const PROFILES = Object.freeze({
  [PREPARED_TEXT_BINDING_SCHEMA]: Object.freeze({ room: "finance", sourceIndex: "finance-cfo-source-docs", sourceSchema: PREPARED_TEXT_SOURCE_SCHEMA, sourceId: "cfotext" }),
  [COMPANY_PREPARED_TEXT_BINDING_SCHEMA]: Object.freeze({ room: "legal_company", sourceIndex: "legal-company", sourceSchema: COMPANY_PREPARED_TEXT_SOURCE_SCHEMA, sourceId: "companytext" })
});

function fail() {
  throw Object.assign(new Error("prepared_text_binding_invalid"), { code: "prepared_text_binding_invalid" });
}

function exactPlain(value, keys) {
  return !!value && Object.getPrototypeOf(value) === Object.prototype &&
    Object.keys(value).sort().join() === keys.join();
}

export function validatePreparedTextBinding(value) {
  const profile = PROFILES[value?.schema];
  if (!exactPlain(value, BINDING_KEYS) || !profile ||
      !RUN_ID_RE.test(value.run_id || "") || value.room !== profile.room ||
      value.source_index !== profile.sourceIndex ||
      !HASH_RE.test(value.catalog_manifest_sha256 || "") ||
      !Number.isSafeInteger(value.document_ordinal) || value.document_ordinal < 0 || value.document_ordinal >= 100 ||
      !SOURCE_VERSION_RE.test(value.source_document_version || "") ||
      !HASH_RE.test(value.catalog_source_sha256 || "") ||
      !SNAPSHOT_ID_RE.test(value.snapshot_id || "") ||
      !HASH_RE.test(value.prepared_manifest_sha256 || "") ||
      !HASH_RE.test(value.sidecar_content_sha256 || "") ||
      !Number.isSafeInteger(value.chunk_ordinal) || value.chunk_ordinal < 0 || value.chunk_ordinal >= 100 ||
      !HASH_RE.test(value.chunk_sha256 || "")) fail();
  return Object.freeze(structuredClone(value));
}

export function preparedTextIdentity(input) {
  if (!exactPlain(input, ["purpose", "source_binding"]) || !PURPOSE_RE.test(input.purpose || "")) fail();
  const sourceBinding = validatePreparedTextBinding(input.source_binding);
  const profile = PROFILES[sourceBinding.schema];
  const sourceVersion = `txtchunk_${sha256(canonical(sourceBinding))}`;
  const sourceId = `${profile.sourceId}_${sha256(canonical({
    schema: profile.sourceSchema,
    purpose: input.purpose,
    source_binding: sourceBinding
  }))}`;
  return Object.freeze({ source_id: sourceId, source_version: sourceVersion });
}
