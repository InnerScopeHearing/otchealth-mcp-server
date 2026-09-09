import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createGatewayRelationshipStore, RELATIONSHIP_ARTIFACT_BUCKET } from "./gateway-store.mjs";

const canonical = value => value === null || typeof value !== "object" ? JSON.stringify(value) : Array.isArray(value)
  ? `[${value.map(canonical).join(",")}]` : `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
const hash = value => createHash("sha256").update(value).digest("hex");
const content = { ref_version: "neptune-trial-active-run-ref-v1", purpose: "relationship-candidates", scope: "finance", run_version: "synthetic-v1", manifest_sha256: "a".repeat(64) };
const run = Object.freeze({ ...content, run_id: `run_${hash(canonical(content))}` });
const producer = "resolver";
const digest = "b".repeat(64);
const key = `resolution-artifacts/sha256/bb/${digest}.json`;
function fakeFactory(captured) {
  return config => {
    captured.config = config;
    return Object.freeze({
      async putArtifact(payload, options) {
        captured.payload = payload; captured.options = options;
        await config.authorizeArtifact({ action: "put", scope: config.scope, artifact_id: `resart_${digest}`, sha256: digest });
        const signed = await config.signRequest({ method: "PUT", url: `https://${RELATIONSHIP_ARTIFACT_BUCKET}.s3.us-east-1.amazonaws.com/${config.prefix}/${key}`,
          service: "s3", region: "us-east-1", headers: { "content-type": "application/json", "if-none-match": "*", "x-amz-server-side-encryption": "AES256" }, body: "{}" });
        captured.signed = signed;
        return config.fetchImpl(signed.url, { method: "PUT", headers: signed.headers, body: "{}", redirect: "error" });
      },
      async getArtifact() { return null; },
    });
  };
}
test("fixed relationship artifact transport maps only the bounded S3 key to the authenticated gateway", async () => {
  const captured = {}; const calls = [];
  const store = createGatewayRelationshipStore({ createS3ResolutionStore: fakeFactory(captured), gatewayOrigin: "https://mcp.otchealth.app", run, producer,
    authorizeArtifact: async request => { calls.push(request); return { allowed: true }; }, getAuthorization: async () => "Bearer synthetic-token-value-1234",
    fetchImpl: async (url, init) => { captured.fetch = { url, init }; return new Response("", { status: 201 }); }, sse: { algorithm: "AES256" },
    historyTrust: { store_id: "synthetic-store", producer_ids: [producer] } });
  await store.putArtifact({ schema: "resolution-source-input-v1", run, input: {} }, { scope: { run_id: run.run_id, caller_seat: "cfo" } });
  assert.equal(captured.config.bucket, RELATIONSHIP_ARTIFACT_BUCKET);
  assert.equal(captured.config.prefix, `graph-trial/20260908/workers/cfo/${run.run_id}/relationship-producers/${producer}`);
  assert.equal(captured.signed.url, `https://mcp.otchealth.app/relationship-artifacts/v1/${run.run_id}/${producer}/sha256/bb/${digest}.json`);
  assert.deepEqual(captured.fetch.init.headers, { "content-type": "application/json", "if-none-match": "*", "x-amz-server-side-encryption": "AES256", authorization: "Bearer synthetic-token-value-1234" });
  assert.equal(calls[0].scope.caller_seat, "cfo");
  assert.deepEqual(store.boundHistoryTrust, { store_id: "synthetic-store", producer_ids: [producer] });
  await assert.rejects(store.putArtifact({ schema: "resolution-source-input-v1", run: { ...run, run_id: "run_" + "c".repeat(64) }, input: {} }),
    { code: "gateway_relationship_store_scope_invalid" });
});
test("signed S3 and gateway routes reject query, key, header, and scope substitution", async () => {
  const captured = {}; const store = createGatewayRelationshipStore({ createS3ResolutionStore: fakeFactory(captured), gatewayOrigin: "https://mcp.otchealth.app", run, producer,
    authorizeArtifact: async () => ({ allowed: true }), getAuthorization: async () => "Bearer synthetic-token-value-1234", fetchImpl: async () => new Response(""), sse: { algorithm: "AES256" },
    historyTrust: { store_id: "synthetic-store", producer_ids: [producer] } });
  await assert.rejects(captured.config.signRequest({ method: "PUT", url: "https://example.com/nope", service: "s3", region: "us-east-1", headers: {}, body: "" }),
    { code: "gateway_relationship_store_route_invalid" });
  await assert.rejects(captured.config.fetchImpl("https://mcp.otchealth.app/relationship-artifacts/v1/other/x/sha256/bb/" + digest + ".json", { method: "GET", headers: { authorization: "Bearer synthetic-token-value-1234" }, redirect: "error" }),
    { code: "gateway_relationship_store_route_invalid" });
  await assert.rejects(store.getArtifact({}, { scope: captured.config.scope }), { code: "gateway_relationship_store_scope_invalid" });
  assert.throws(() => createGatewayRelationshipStore({ createS3ResolutionStore: fakeFactory({}), gatewayOrigin: "https://synthetic.invalid", run, producer,
    authorizeArtifact: async () => ({ allowed: true }), getAuthorization: async () => "Bearer synthetic-token-value-1234", fetchImpl: async () => new Response(""),
    sse: { algorithm: "AES256" }, historyTrust: { store_id: "synthetic-store", producer_ids: ["different-producer"] } }),
    { code: "gateway_relationship_store_configuration" });
});
