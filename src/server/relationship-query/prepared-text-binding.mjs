import { canonical, sha256 } from "./aws-http.mjs";

export const PREPARED_TEXT_BINDING_SCHEMA = "cfo-prepared-chunk-binding-v1";
export const PREPARED_TEXT_SOURCE_SCHEMA = "cfo-prepared-chunk-source-v1";

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

function fail() {
  throw Object.assign(new Error("prepared_text_binding_invalid"), { code: "prepared_text_binding_invalid" });
}

function exactPlain(value, keys) {
  return !!value && Object.getPrototypeOf(value) === Object.prototype &&
    Object.keys(value).sort().join() === keys.join();
}

export function validatePreparedTextBinding(value) {
  if (!exactPlain(value, BINDING_KEYS) || value.schema !== PREPARED_TEXT_BINDING_SCHEMA ||
      !RUN_ID_RE.test(value.run_id || "") || value.room !== "finance" ||
      value.source_index !== "finance-cfo-source-docs" ||
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
  const sourceVersion = `txtchunk_${sha256(canonical(sourceBinding))}`;
  const sourceId = `cfotext_${sha256(canonical({
    schema: PREPARED_TEXT_SOURCE_SCHEMA,
    purpose: input.purpose,
    source_binding: sourceBinding
  }))}`;
  return Object.freeze({ source_id: sourceId, source_version: sourceVersion });
}
