import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createHistoricalRelationshipReader, RELATIONSHIP_ARTIFACT_BUCKET } from "./historical-reader.mjs";
const canonical = v => v === null || typeof v !== "object" ? JSON.stringify(v) : Array.isArray(v) ? `[${v.map(canonical).join(",")}]` : `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
const hash = v => createHash("sha256").update(v).digest("hex");
const content = { ref_version: "neptune-trial-active-run-ref-v1", purpose: "relationship-candidates", scope: "finance", run_version: "synthetic-v1", manifest_sha256: "a".repeat(64) };
const run = Object.freeze({ ...content, run_id: `run_${hash(canonical(content))}` });
const payload = Object.freeze({ schema: "resolution-history-v1", run, caller_seat: "cfo", sources: [], events: [], queries: [] });
const digest = hash(canonical(payload)); const ref = Object.freeze({ schema: "relationship-resolution-artifact-ref-v1", artifact_id: `resart_${digest}`, bucket: RELATIONSHIP_ARTIFACT_BUCKET, key: `resolution-artifacts/sha256/${digest.slice(0, 2)}/${digest}.json`, payload_sha256: digest, size_bytes: Buffer.byteLength(canonical(payload)), version_id: "version-1" });
function headers(overrides = {}) { return { "x-amz-version-id": ref.version_id, "x-amz-server-side-encryption": "AES256", "x-relationship-source-current": "true", "x-relationship-policy-version": "synthetic-policy", "x-relationship-policy-expires-at": new Date(Date.now() + 60_000).toISOString(), "x-relationship-producer": "resolver", ...overrides }; }
function reader(response, overrides = {}) { const calls = []; return { calls, value: createHistoricalRelationshipReader({ gatewayOrigin: "https://mcp.otchealth.app", run, producer: "resolver", historyTrust: { store_id: "synthetic", producer_ids: ["resolver"] }, sse: { algorithm: "AES256" }, now: Date.now, getAuthorization: async () => "Bearer synthetic-token-value-1234", fetchImpl: async (url, init) => { calls.push({ url, init }); return response; }, ...overrides }) }; }
function cancellableResponse({ status = 200, responseHeaders = headers() } = {}) { let cancelled = false; const body = new ReadableStream({ pull() { return new Promise(() => {}); }, cancel() { cancelled = true; } }); return { response: new Response(body, { status, headers: responseHeaders }), get cancelled() { return cancelled; } }; }
test("reader performs one authenticated GET and returns only verified payload plus gateway authority", async () => {
  const h = reader(new Response(JSON.stringify({ schema: "relationship-resolution-artifact-v1", payload_sha256: digest, payload }), { status: 200, headers: headers() }));
  const result = await h.value.readArtifact(ref); assert.deepEqual(result.payload, payload); assert.equal(result.authority.authenticated_gateway, true); assert.equal(result.authority.current, true);
  assert.equal(h.calls[0].init.method, "GET"); assert.match(h.calls[0].url, new RegExp(`/relationship-history/v1/${run.run_id}/resolver/sha256/${digest.slice(0, 2)}/${digest}\\.json\\?versionId=version-1$`));
});
test("wrong refs, corrupt payloads, headers, expiry, and oversized responses fail closed", async () => {
  await assert.rejects(reader(new Response("", { status: 200, headers: headers() })).value.readArtifact({ ...ref, bucket: "other" }), { code: "relationship_history_ref_invalid" });
  await assert.rejects(reader(new Response(JSON.stringify({ schema: "relationship-resolution-artifact-v1", payload_sha256: digest, payload: { ...payload, caller_seat: "clo" } }), { status: 200, headers: headers() })).value.readArtifact(ref), { code: "relationship_history_corrupt" });
  await assert.rejects(reader(new Response(JSON.stringify({ schema: "relationship-resolution-artifact-v1", payload_sha256: digest, payload }), { status: 200, headers: headers({ "x-relationship-producer": "other" }) })).value.readArtifact(ref), { code: "relationship_history_gateway_invalid" });
  await assert.rejects(reader(new Response(JSON.stringify({ schema: "relationship-resolution-artifact-v1", payload_sha256: digest, payload }), { status: 200, headers: headers({ "x-relationship-policy-expires-at": new Date(Date.now() - 1).toISOString() }) })).value.readArtifact(ref), { code: "relationship_history_gateway_invalid" });
  await assert.rejects(reader(new Response("x", { status: 200, headers: headers({ "content-length": String(16 * 1024 * 1024 + 1025) }) })).value.readArtifact(ref), { code: "relationship_history_response_too_large" });
  await assert.rejects(reader(new Response("x", { status: 200, headers: headers({ "content-length": "2" }) })).value.readArtifact(ref), { code: "relationship_history_response_invalid" });
});
test("authorization and streaming reads have internal deadlines, and expiry is checked after the body", async () => {
  let authSignal; const hangingAuth = reader(new Response(""), { timeoutMs: 5, getAuthorization: async (_request, { signal }) => { authSignal = signal; return new Promise(() => {}); } });
  await assert.rejects(hangingAuth.value.readArtifact(ref), { code: "relationship_history_deadline" }); assert.equal(authSignal.aborted, true);
  const body = new ReadableStream({ pull() { return new Promise(() => {}); }, cancel() { return new Promise(() => {}); } });
  let bodyFetchSignal; const hangingRead = reader(new Response(body, { status: 200, headers: headers() }), { timeoutMs: 5, fetchImpl: async (_url, init) => { bodyFetchSignal = init.signal; return new Response(body, { status: 200, headers: headers() }); } });
  await assert.rejects(hangingRead.value.readArtifact(ref), { code: "relationship_history_deadline" }); assert.equal(bodyFetchSignal.aborted, true);
  const base = Date.now(); let clockCalls = 0;
  const expiredAfterRead = reader(new Response(JSON.stringify({ schema: "relationship-resolution-artifact-v1", payload_sha256: digest, payload }), { status: 200, headers: headers({ "x-relationship-policy-expires-at": new Date(base + 1_000).toISOString() }) }),
    { now: () => (++clockCalls > 2 ? base + 2_000 : base) });
  await assert.rejects(expiredAfterRead.value.readArtifact(ref), { code: "relationship_history_gateway_invalid" });
});
test("the fetch signal stays live until a delayed body is consumed", async () => {
  const text = JSON.stringify({ schema: "relationship-resolution-artifact-v1", payload_sha256: digest, payload }); let captured;
  const h = reader(undefined, { timeoutMs: 100, fetchImpl: async (_url, init) => {
    captured = init.signal; const body = new ReadableStream({ start(controller) { const timer = setTimeout(() => { controller.enqueue(Buffer.from(text)); controller.close(); }, 15); init.signal.addEventListener("abort", () => { clearTimeout(timer); controller.error(Object.assign(new Error("aborted"), { name: "AbortError" })); }, { once: true }); } });
    return new Response(body, { status: 200, headers: headers({ "content-length": String(Buffer.byteLength(text)) }) });
  } });
  const result = await h.value.readArtifact(ref); assert.deepEqual(result.payload, payload); assert.equal(captured.aborted, true);
});
test("caller aborts and rejected responses cancel their bodies", async () => {
  const caller = new AbortController(); let fetchSignal;
  const hanging = reader(undefined, { timeoutMs: 100, fetchImpl: async (_url, init) => { fetchSignal = init.signal; return new Promise(() => {}); } });
  const pending = hanging.value.readArtifact(ref, { signal: caller.signal }); setTimeout(() => caller.abort(), 5);
  await assert.rejects(pending, { code: "relationship_history_deadline" }); assert.equal(fetchSignal.aborted, true);
  const forbidden = cancellableResponse({ status: 403 }); await assert.rejects(reader(forbidden.response).value.readArtifact(ref), { code: "relationship_history_forbidden" }); assert.equal(forbidden.cancelled, true);
  const invalidHeaders = cancellableResponse({ responseHeaders: headers({ "x-relationship-producer": "other" }) }); await assert.rejects(reader(invalidHeaders.response).value.readArtifact(ref), { code: "relationship_history_gateway_invalid" }); assert.equal(invalidHeaders.cancelled, true);
  const tooLarge = cancellableResponse({ responseHeaders: headers({ "content-length": String(16 * 1024 * 1024 + 1025) }) }); await assert.rejects(reader(tooLarge.response).value.readArtifact(ref), { code: "relationship_history_response_too_large" }); assert.equal(tooLarge.cancelled, true);
});
