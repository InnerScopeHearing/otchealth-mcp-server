import { createHash } from "node:crypto";

export const RELATIONSHIP_ARTIFACT_BUCKET = "otchealth-finance-legal-dr-55c84f6b";
const HASH = /^[a-f0-9]{64}$/;
const PRODUCER = /^[a-z][a-z0-9-]{0,63}$/;
const VERSION = /^[^\s\p{C}]{1,1024}$/u;
const MAX_PAYLOAD = 16 * 1024 * 1024;
const MAX_DEPTH = 128;
const DEFAULT_TIMEOUT_MS = 30_000;
const fail = code => { throw Object.assign(new Error(code), { code }); };
const canonical = value => value === null || typeof value !== "object" ? JSON.stringify(value) : Array.isArray(value)
  ? `[${value.map(canonical).join(",")}]` : `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
const hash = value => createHash("sha256").update(value).digest("hex");
const exact = (value, keys) => !!value && Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
const same = (a, b) => canonical(a) === canonical(b);
function active(signal) { if (signal?.aborted) fail("relationship_history_deadline"); }
function abortable(value, signal) { active(signal); return new Promise((resolve, reject) => { const abort = () => reject(Object.assign(new Error("relationship_history_deadline"), { code: "relationship_history_deadline" })); signal?.addEventListener("abort", abort, { once: true }); Promise.resolve(value).then(resolve, reject).finally(() => signal?.removeEventListener("abort", abort)); }); }
async function boundedCancel(reader) { let timer; try { await Promise.race([Promise.resolve().then(() => reader.cancel()).catch(() => {}), new Promise(resolve => { timer = setTimeout(resolve, 100); })]); } finally { clearTimeout(timer); } }
function deadlineScope(signal, timeoutMs) {
  active(signal); const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs); const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  return Object.freeze({ signal: combined, async wait(value) { try { return await abortable(value, combined); } catch (error) { if (combined.aborted) fail("relationship_history_deadline"); throw error; } }, close() { clearTimeout(timer); controller.abort(); } });
}
async function deadline(signal, timeoutMs, operation) { const scope = deadlineScope(signal, timeoutMs); try { return await scope.wait(operation(scope.signal)); } finally { scope.close(); } }
async function boundedCancelResponse(response) { const body = response?.body; if (!body) return; const reader = body.getReader?.(); if (reader) return boundedCancel(reader); if (typeof body.cancel === "function") return boundedCancel({ cancel: () => body.cancel() }); }
function validRun(value) {
  if (!exact(value, ["ref_version", "run_id", "purpose", "scope", "run_version", "manifest_sha256"])) return false;
  const content = { ref_version: value.ref_version, purpose: value.purpose, scope: value.scope, run_version: value.run_version, manifest_sha256: value.manifest_sha256 };
  return value.ref_version === "neptune-trial-active-run-ref-v1" && /^run_[a-f0-9]{64}$/.test(value.run_id || "") && value.scope === "finance" &&
    /^[a-z0-9][a-z0-9_.:-]{0,95}$/.test(value.purpose || "") && /^[a-z0-9][a-z0-9_.:-]{0,95}$/.test(value.run_version || "") &&
    HASH.test(value.manifest_sha256 || "") && value.run_id === `run_${hash(canonical(content))}`;
}
function originOf(value) { let url; try { url = new URL(value); } catch { fail("relationship_history_configuration"); }
  if (url.protocol !== "https:" || !url.hostname || url.port || url.username || url.password || url.pathname !== "/" || url.search || url.hash) fail("relationship_history_configuration"); return url.origin; }
function utc(value) { return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value; }
function header(response, name) { const value = response.headers?.get?.(name); return typeof value === "string" && value ? value : null; }
function json(value, seen = new Set(), depth = 0) {
  if (depth > MAX_DEPTH) fail("relationship_history_corrupt");
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") { if (!Number.isFinite(value)) fail("relationship_history_corrupt"); return; }
  if (!value || typeof value !== "object" || seen.has(value)) fail("relationship_history_corrupt");
  seen.add(value); if (Array.isArray(value)) for (const v of value) json(v, seen, depth + 1); else if (Object.getPrototypeOf(value) !== Object.prototype) fail("relationship_history_corrupt"); else for (const v of Object.values(value)) json(v, seen, depth + 1); seen.delete(value);
}
async function bounded(response, signal) {
  const rawDeclared = response.headers?.get?.("content-length"); const declared = rawDeclared === null || rawDeclared === undefined ? null : Number(rawDeclared);
  if (declared !== null && (!Number.isSafeInteger(declared) || declared < 0)) { await boundedCancelResponse(response); fail("relationship_history_response_invalid"); }
  if (declared !== null && declared > MAX_PAYLOAD + 1024) { await boundedCancelResponse(response); fail("relationship_history_response_too_large"); }
  const reader = response.body?.getReader?.(); if (!reader) { const bytes = Buffer.from(await abortable(response.arrayBuffer(), signal)); if (bytes.length > MAX_PAYLOAD + 1024) fail("relationship_history_response_too_large"); if (declared !== null && bytes.length !== declared) fail("relationship_history_response_invalid"); return bytes; }
  const chunks = []; let size = 0; try { for (;;) { active(signal); const next = await abortable(reader.read(), signal); active(signal); if (next.done) break; size += next.value.byteLength; if (size > MAX_PAYLOAD + 1024) { await boundedCancel(reader); fail("relationship_history_response_too_large"); } chunks.push(Buffer.from(next.value)); } } catch (error) { await boundedCancel(reader); throw error; }
  if (declared !== null && size !== declared) fail("relationship_history_response_invalid"); return Buffer.concat(chunks, size);
}
function refOf(ref) {
  if (!exact(ref, ["artifact_id", "bucket", "key", "payload_sha256", "schema", "size_bytes", "version_id"]) || ref.schema !== "relationship-resolution-artifact-ref-v1" || ref.bucket !== RELATIONSHIP_ARTIFACT_BUCKET ||
      !HASH.test(ref.payload_sha256 || "") || ref.artifact_id !== `resart_${ref.payload_sha256}` || ref.key !== `resolution-artifacts/sha256/${ref.payload_sha256.slice(0, 2)}/${ref.payload_sha256}.json` ||
      !VERSION.test(ref.version_id || "") || ref.version_id === "null" || !Number.isSafeInteger(ref.size_bytes) || ref.size_bytes < 0 || ref.size_bytes > MAX_PAYLOAD) fail("relationship_history_ref_invalid");
  return Object.freeze(structuredClone(ref));
}
function trustOf(value, producer) {
  if (!exact(value, ["store_id", "producer_ids"]) || typeof value.store_id !== "string" || !value.store_id || !Array.isArray(value.producer_ids) || !value.producer_ids.length || value.producer_ids.some(id => !PRODUCER.test(id || "")) || !value.producer_ids.includes(producer)) fail("relationship_history_configuration");
  return Object.freeze({ store_id: value.store_id, producer_ids: Object.freeze([...new Set(value.producer_ids)]) });
}
function payloadOf(value, run) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) return false;
  if (value.schema === "resolution-source-input-v1") return exact(value, ["schema", "run", "input"]) && same(value.run, run);
  return value.schema === "resolution-history-v1" && exact(value, ["schema", "run", "caller_seat", "sources", "events", "queries"]) && same(value.run, run) && value.caller_seat === "cfo" && Array.isArray(value.sources) && Array.isArray(value.events) && Array.isArray(value.queries);
}

export function createHistoricalRelationshipReader({ gatewayOrigin, run, producer, historyTrust, getAuthorization, fetchImpl, now = Date.now, sse, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (!validRun(run) || !PRODUCER.test(producer || "") || typeof getAuthorization !== "function" || typeof fetchImpl !== "function" || typeof now !== "function" ||
      !sse || !exact(sse, sse.algorithm === "AES256" ? ["algorithm"] : ["algorithm", "kmsKeyId"]) || !["AES256", "aws:kms"].includes(sse.algorithm) || (sse.algorithm === "aws:kms" && (typeof sse.kmsKeyId !== "string" || !sse.kmsKeyId)) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > DEFAULT_TIMEOUT_MS) fail("relationship_history_configuration");
  const origin = originOf(gatewayOrigin), fixedRun = Object.freeze(structuredClone(run)), trust = trustOf(historyTrust, producer), encryption = Object.freeze(structuredClone(sse));
  async function readArtifact(rawRef, { signal } = {}) {
    active(signal); const ref = refOf(rawRef); let authorization;
    try { authorization = await deadline(signal, timeoutMs, requestSignal => getAuthorization(Object.freeze({ run: fixedRun, caller_seat: "cfo", producer_id: producer }), { signal: requestSignal })); } catch (error) { if (error?.code === "relationship_history_deadline") throw error; fail("relationship_history_auth_failed"); }
    if (typeof authorization !== "string" || !/^Bearer [^\s]{16,8192}$/.test(authorization)) fail("relationship_history_auth_failed");
    const url = `${origin}/relationship-history/v1/${fixedRun.run_id}/${producer}/sha256/${ref.payload_sha256.slice(0, 2)}/${ref.payload_sha256}.json?versionId=${encodeURIComponent(ref.version_id)}`;
    const request = deadlineScope(signal, timeoutMs); let response, bytes, policyVersion, expiresAt, current;
    try {
      try { response = await request.wait(fetchImpl(url, { method: "GET", headers: Object.freeze({ authorization }), signal: request.signal, redirect: "error" })); } catch (error) { if (error?.code === "relationship_history_deadline" || signal?.aborted || error?.name === "AbortError") fail("relationship_history_deadline"); fail("relationship_history_transport_unknown"); }
      active(request.signal); if (response.status !== 200) { await boundedCancelResponse(response); fail(response.status === 401 || response.status === 403 ? "relationship_history_forbidden" : "relationship_history_unavailable"); }
      policyVersion = header(response, "x-relationship-policy-version"); expiresAt = header(response, "x-relationship-policy-expires-at"); current = header(response, "x-relationship-source-current");
      if (header(response, "x-amz-version-id") !== ref.version_id || header(response, "x-amz-server-side-encryption") !== encryption.algorithm ||
          (encryption.algorithm === "aws:kms" && header(response, "x-amz-server-side-encryption-aws-kms-key-id") !== encryption.kmsKeyId) || header(response, "x-relationship-producer") !== producer ||
          !policyVersion || !utc(expiresAt) || Date.parse(expiresAt) <= now() || Date.parse(expiresAt) - now() > 300000 || !["true", "false"].includes(current)) { await boundedCancelResponse(response); fail("relationship_history_gateway_invalid"); }
      bytes = await request.wait(bounded(response, request.signal));
    } finally { request.close(); }
    if (!Buffer.from(bytes.toString("utf8"), "utf8").equals(bytes)) fail("relationship_history_corrupt");
    let envelope; try { envelope = JSON.parse(bytes.toString("utf8")); } catch { fail("relationship_history_corrupt"); }
    if (!exact(envelope, ["schema", "payload_sha256", "payload"]) || envelope.schema !== "relationship-resolution-artifact-v1" || envelope.payload_sha256 !== ref.payload_sha256) fail("relationship_history_corrupt");
    json(envelope.payload); const payloadText = canonical(envelope.payload);
    if (!payloadOf(envelope.payload, fixedRun) || hash(payloadText) !== ref.payload_sha256 || Buffer.byteLength(payloadText) !== ref.size_bytes) fail("relationship_history_corrupt");
    if (Date.parse(expiresAt) <= now() || Date.parse(expiresAt) - now() > 300000) fail("relationship_history_gateway_invalid");
    return Object.freeze({ payload: structuredClone(envelope.payload), authority: Object.freeze({ authenticated_gateway: true, policy_version: policyVersion, expires_at: expiresAt, producer_id: producer, caller_seat: "cfo", current: current === "true" }) });
  }
  return Object.freeze({ readArtifact, run_id: fixedRun.run_id, producer_id: producer, boundHistoryTrust: trust });
}
