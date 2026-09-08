import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createPagedRecallHost } from "./paged-recall-host.mjs";

const canonical = value => value === null || typeof value !== "object" ? JSON.stringify(value) : Array.isArray(value) ? `[${value.map(canonical).join(",")}]` : `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
const hash = value => createHash("sha256").update(value).digest("hex");
const run = index => { const value = { ref_version: "neptune-trial-active-run-ref-v1", purpose: `cross-${index}`, scope: "finance", run_version: "v1", manifest_sha256: hash(`manifest-${index}`) }; return { ...value, run_id: `run_${hash(canonical(value))}` }; };
const ref = index => { const digest = hash(`artifact-${index}`); return { schema: "relationship-resolution-artifact-ref-v1", artifact_id: `resart_${digest}`,
  bucket: "otchealth-finance-legal-dr-55c84f6b", key: `resolution-artifacts/sha256/${digest.slice(0, 2)}/${digest}.json`, payload_sha256: digest, size_bytes: 1, version_id: "v1" }; };
const item = index => ({ run: run(index), producer_id: "cfo-worker", artifact_ref: ref(index) });
function host(fetchImpl) { return createPagedRecallHost({ gatewayOrigin: "https://gateway.test", cohortId: "finance-history", producer: "cfo-worker",
  historyTrust: { store_id: "trusted", producer_ids: ["cfo-worker"] }, sse: { algorithm: "AES256" }, getAuthorization: async () => "Bearer 1234567890abcdef",
  fetchImpl, createResolver: () => ({}), bindPreparedSource: () => ({}), verificationRequestHash: () => "x", now: () => Date.parse("2026-09-08T00:00:00.000Z") }); }
function json(value) { return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } }); }

test("list traverses server pages above 64 items without retaining or scanning the corpus", async () => {
  const calls = []; const all = Array.from({ length: 66 }, (_, index) => item(index + 1)).sort((left, right) => left.run.run_id.localeCompare(right.run.run_id)); const first = all.slice(0, 64), second = all.slice(64);
  const client = host(async url => { calls.push(new URL(url)); const after = new URL(url).searchParams.get("after");
    return json({ schema: "relationship-publication-page-v1", items: after ? second : first, next_after: after ? null : first.at(-1).run.run_id }); });
  const page1 = await client.list({ limit: 64 }); const page2 = await client.list({ after: page1.next_after, limit: 64 });
  assert.equal(page1.items.length, 64); assert.equal(page2.items.length, 2); assert.equal(calls.length, 2);
  assert.equal(calls[1].searchParams.get("after"), page1.next_after);
});

test("publish has a bounded route and accepts an idempotent server receipt", async () => {
  let observed; const client = host(async (url, init) => { observed = { url, init }; return json({ schema: "relationship-publication-receipt-v1", item: item(1) }); });
  const result = await client.publish({ run: run(1), artifact_ref: ref(1) });
  assert.equal(result.producer_id, "cfo-worker"); assert.equal(observed.init.method, "POST"); assert.equal(new URL(observed.url).pathname, "/relationship-publications/v1/finance-history/cfo-worker");
});

test("rejects malformed server ordering, cursors, and over-limit requests", async () => {
  const client = host(async () => json({ schema: "relationship-publication-page-v1", items: [item(2), item(1)], next_after: null }));
  await assert.rejects(client.list({ limit: 64 }), { code: "paged_recall_page_invalid" });
  await assert.rejects(client.list({ limit: 65 }), { code: "paged_recall_limit_invalid" });
  await assert.rejects(client.list({ after: "not-a-run" }), { code: "paged_recall_cursor_invalid" });
});

test("caller cancellation bounds a hanging publication fetch", async () => {
  const client = host(async () => new Promise(() => {})), controller = new AbortController(); setTimeout(() => controller.abort(), 10);
  await assert.rejects(client.list({ signal: controller.signal }), { code: "paged_recall_deadline" });
});
