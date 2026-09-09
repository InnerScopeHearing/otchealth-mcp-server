import { createHash } from "node:crypto";

export const RELATIONSHIP_ARTIFACT_BUCKET = "otchealth-finance-legal-dr-55c84f6b";
export const RELATIONSHIP_ARTIFACT_REGION = "us-east-1";
const WORKERS_PREFIX = "graph-trial/20260908/workers/cfo";
const PRODUCER = /^[a-z][a-z0-9-]{0,63}$/;
const HASH = /^[a-f0-9]{64}$/;
const VERSION = /^[^\s]{1,1024}$/;
const fail = code => { throw Object.assign(new Error(code), { code }); };
const canonical = value => value === null || typeof value !== "object" ? JSON.stringify(value) : Array.isArray(value)
  ? `[${value.map(canonical).join(",")}]` : `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
const hash = value => createHash("sha256").update(value).digest("hex");
const exact = (value, keys) => !!value && Object.getPrototypeOf(value) === Object.prototype &&
  Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
function same(left, right) { return canonical(left) === canonical(right); }
function validRun(value) {
  if (!exact(value, ["ref_version", "run_id", "purpose", "scope", "run_version", "manifest_sha256"])) return false;
  const content = { ref_version: value.ref_version, purpose: value.purpose, scope: value.scope,
    run_version: value.run_version, manifest_sha256: value.manifest_sha256 };
  return value.ref_version === "neptune-trial-active-run-ref-v1" && /^run_[a-f0-9]{64}$/.test(value.run_id || "") &&
    /^[a-z0-9][a-z0-9_.:-]{0,95}$/.test(value.purpose || "") && value.scope === "finance" &&
    /^[a-z0-9][a-z0-9_.:-]{0,95}$/.test(value.run_version || "") && HASH.test(value.manifest_sha256 || "") &&
    value.run_id === `run_${hash(canonical(content))}`;
}
function fixedOrigin(value) {
  let url;
  try { url = new URL(value); } catch { fail("gateway_relationship_store_configuration"); }
  if (url.protocol !== "https:" || !url.hostname || url.port || url.username || url.password || url.pathname !== "/" || url.search || url.hash)
    fail("gateway_relationship_store_configuration");
  return url.origin;
}
function normalizeSse(value) {
  if (!value || !exact(value, value.algorithm === "AES256" ? ["algorithm"] : ["algorithm", "kmsKeyId"]) ||
      !["AES256", "aws:kms"].includes(value.algorithm) ||
      (value.algorithm === "aws:kms" && (typeof value.kmsKeyId !== "string" || !value.kmsKeyId || value.kmsKeyId.length > 1024))) {
    fail("gateway_relationship_store_configuration");
  }
  return Object.freeze(value.algorithm === "AES256" ? { algorithm: "AES256" } : { algorithm: "aws:kms", kmsKeyId: value.kmsKeyId });
}
function normalizeHistoryTrust(value, producer) {
  if (!exact(value, ["store_id", "producer_ids"]) || typeof value.store_id !== "string" || !value.store_id || value.store_id.length > 240 ||
      !Array.isArray(value.producer_ids) || !value.producer_ids.length || value.producer_ids.length > 128 ||
      value.producer_ids.some(id => !PRODUCER.test(id || "")) || !value.producer_ids.includes(producer)) fail("gateway_relationship_store_configuration");
  return Object.freeze({ store_id: value.store_id, producer_ids: Object.freeze([...new Set(value.producer_ids)]) });
}
function physicalPrefix(run, producer) { return `${WORKERS_PREFIX}/${run.run_id}/relationship-producers/${producer}`; }
function scopedPayload(value, run) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) return false;
  if (value.schema === "resolution-source-input-v1") return exact(value, ["schema", "run", "input"]) && same(value.run, run);
  return value.schema === "resolution-history-v1" && exact(value, ["schema", "run", "caller_seat", "sources", "events", "queries"]) &&
    same(value.run, run) && value.caller_seat === "cfo" && Array.isArray(value.sources) && Array.isArray(value.events) && Array.isArray(value.queries);
}
function validateS3Request(urlText, { method, headers, body }, fixed) {
  let url;
  try { url = new URL(urlText); } catch { fail("gateway_relationship_store_route_invalid"); }
  const expectedHost = `${RELATIONSHIP_ARTIFACT_BUCKET}.s3.${RELATIONSHIP_ARTIFACT_REGION}.amazonaws.com`;
  const prefix = physicalPrefix(fixed.run, fixed.producer);
  const match = new RegExp(`^/${prefix}/resolution-artifacts/sha256/([a-f0-9]{2})/([a-f0-9]{64})\\.json$`).exec(url.pathname);
  if (url.protocol !== "https:" || url.hostname !== expectedHost || url.port || url.username || url.password || url.hash || !match || match[1] !== match[2].slice(0, 2))
    fail("gateway_relationship_store_route_invalid");
  const entries = [...url.searchParams.entries()];
  if (method === "PUT") {
    if (url.search || !exact(headers, fixed.sse.algorithm === "AES256"
      ? ["content-type", "if-none-match", "x-amz-server-side-encryption"]
      : ["content-type", "if-none-match", "x-amz-server-side-encryption", "x-amz-server-side-encryption-aws-kms-key-id"]) ||
      headers["content-type"] !== "application/json" || headers["if-none-match"] !== "*" ||
      headers["x-amz-server-side-encryption"] !== fixed.sse.algorithm ||
      (fixed.sse.algorithm === "aws:kms" && headers["x-amz-server-side-encryption-aws-kms-key-id"] !== fixed.sse.kmsKeyId) || typeof body !== "string")
      fail("gateway_relationship_store_route_invalid");
  } else if (method === "GET") {
    if (!exact(headers, []) || typeof body !== "string" || entries.length > 1 || entries.some(([name, value]) => name !== "versionId" || !VERSION.test(value) || value === "null"))
      fail("gateway_relationship_store_route_invalid");
  } else fail("gateway_relationship_store_route_invalid");
  return Object.freeze({ digest: match[2], versionId: entries[0]?.[1] ?? null });
}

/**
 * Gateway-only transport for the immutable relationship artifact store. Artifact
 * refs retain the underlying bare key; their run and producer are fixed here and
 * must be supplied by trusted workflow configuration when a ref is later opened.
 */
export function createGatewayRelationshipStore({ createS3ResolutionStore, gatewayOrigin, run, producer, authorizeArtifact,
  getAuthorization, fetchImpl, sse, historyTrust } = {}) {
  if (typeof createS3ResolutionStore !== "function" || !validRun(run) || !PRODUCER.test(producer || "") ||
      typeof authorizeArtifact !== "function" || typeof getAuthorization !== "function" || typeof fetchImpl !== "function")
    fail("gateway_relationship_store_configuration");
  const origin = fixedOrigin(gatewayOrigin);
  const fixed = Object.freeze({ run: Object.freeze(structuredClone(run)), producer, sse: normalizeSse(sse),
    historyTrust: normalizeHistoryTrust(historyTrust, producer) });
  const scope = Object.freeze({ run: fixed.run, caller_seat: "cfo", producer_id: producer });
  const prefix = physicalPrefix(fixed.run, producer);

  async function signRequest({ method, url, service, region, headers = {}, body = "" } = {}) {
    if (service !== "s3" || region !== RELATIONSHIP_ARTIFACT_REGION) fail("gateway_relationship_store_route_invalid");
    const route = validateS3Request(url, { method, headers, body }, fixed);
    let authorization;
    try { authorization = await getAuthorization(Object.freeze({ run: fixed.run, caller_seat: "cfo", producer_id: producer })); }
    catch { fail("gateway_relationship_store_auth_failed"); }
    if (typeof authorization !== "string" || !/^Bearer [^\s]{16,8192}$/.test(authorization)) fail("gateway_relationship_store_auth_failed");
    const gatewayUrl = `${origin}/relationship-artifacts/v1/${fixed.run.run_id}/${producer}/sha256/${route.digest.slice(0, 2)}/${route.digest}.json` +
      (route.versionId ? `?versionId=${encodeURIComponent(route.versionId)}` : "");
    return Object.freeze({ url: gatewayUrl, headers: Object.freeze({ ...headers, authorization }) });
  }
  async function gatewayFetch(urlText, init = {}) {
    let url;
    try { url = new URL(urlText); } catch { fail("gateway_relationship_store_route_invalid"); }
    const pattern = new RegExp(`^/relationship-artifacts/v1/${fixed.run.run_id}/${producer}/sha256/[a-f0-9]{2}/[a-f0-9]{64}\\.json$`);
    const forwarded = { ...(init.headers ?? {}) }; const authorization = forwarded.authorization; delete forwarded.authorization;
    if (url.origin !== origin || !pattern.test(url.pathname) || url.hash || url.username || url.password || init.redirect !== "error" ||
        !["GET", "PUT"].includes(init.method) || typeof authorization !== "string" || !/^Bearer [^\s]{16,8192}$/.test(authorization) ||
        (init.method === "GET" && init.body !== undefined) || (init.method === "PUT" && typeof init.body !== "string")) fail("gateway_relationship_store_route_invalid");
    validateS3Request(`https://${RELATIONSHIP_ARTIFACT_BUCKET}.s3.${RELATIONSHIP_ARTIFACT_REGION}.amazonaws.com/${prefix}/resolution-artifacts/sha256/${url.pathname.split("/").at(-2)}/${url.pathname.split("/").at(-1)}` + url.search,
      { method: init.method, headers: forwarded, body: init.method === "GET" ? "" : init.body }, fixed);
    const entries = [...url.searchParams.entries()];
    if ((init.method === "PUT" && entries.length) || (init.method === "GET" && (entries.length > 1 || entries.some(([k, v]) => k !== "versionId" || !VERSION.test(v) || v === "null"))))
      fail("gateway_relationship_store_route_invalid");
    try { return await fetchImpl(url.toString(), { method: init.method, headers: init.headers, body: init.body, signal: init.signal, redirect: "error" }); }
    catch (error) { throw error; }
  }
  async function trustedAuthorize(request) {
    if (!request || !["put", "get"].includes(request.action) || !same(request.scope, scope)) fail("gateway_relationship_store_scope_invalid");
    return authorizeArtifact(Object.freeze({ ...request, scope }));
  }
  const raw = createS3ResolutionStore(Object.freeze({ bucket: RELATIONSHIP_ARTIFACT_BUCKET, prefix, region: RELATIONSHIP_ARTIFACT_REGION,
    signRequest, fetchImpl: gatewayFetch, authorizeArtifact: trustedAuthorize, scope, sse: fixed.sse }));
  if (!raw || typeof raw.putArtifact !== "function" || typeof raw.getArtifact !== "function") fail("gateway_relationship_store_factory_invalid");
  return Object.freeze({
    async putArtifact(payload, { signal, scope: override } = {}) {
      if ((override !== undefined && (!exact(override, ["run_id", "caller_seat"]) || override.run_id !== fixed.run.run_id || override.caller_seat !== "cfo")) ||
          !scopedPayload(payload, fixed.run)) fail("gateway_relationship_store_scope_invalid");
      return raw.putArtifact(payload, { signal });
    },
    async getArtifact(ref, { signal, scope: override } = {}) {
      if (override !== undefined && (!exact(override, ["run_id", "caller_seat"]) || override.run_id !== fixed.run.run_id || override.caller_seat !== "cfo"))
        fail("gateway_relationship_store_scope_invalid");
      return raw.getArtifact(ref, { signal });
    },
    boundHistoryTrust: fixed.historyTrust,
    run_id: fixed.run.run_id,
    producer_id: producer,
  });
}
