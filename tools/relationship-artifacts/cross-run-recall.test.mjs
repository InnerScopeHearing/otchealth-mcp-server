import test from "node:test";
import assert from "node:assert/strict";
import { createCrossRunRecall } from "./cross-run-recall.mjs";

const run = suffix => ({ ref_version: "neptune-trial-active-run-ref-v1", run_id: `run_${suffix.repeat(64)}`, purpose: "cross-run", scope: "finance", run_version: "v1", manifest_sha256: "f".repeat(64) });
const ref = suffix => ({ artifact_id: `resart_${suffix.repeat(64)}`, bucket: "test", key: `k/${suffix}`, payload_sha256: suffix.repeat(64), schema: "relationship-resolution-artifact-ref-v1", size_bytes: 1, version_id: "v1" });
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const bindPreparedSource = input => ({ source_ref: `src_${input.binding.id}`, binding: input.binding });
function createMockResolver(services) {
  const sources = new Map(), records = [];
  return {
    registerSource(input) { const source = bindPreparedSource(input), request = { caller_lane: "cfo", source_ref: source.source_ref, source_binding: source.binding };
      services.authorizeSource(request); services.isCurrentSource({ source_ref: source.source_ref, source_binding: source.binding });
      services.verifyPreparedSource({ caller_lane: "cfo", source }); sources.set(source.source_ref, source); return source.source_ref; },
    accept(input) { const source = sources.get(input.source_ref); services.authorizeSource({ caller_lane: "cfo", source_ref: source.source_ref, source_binding: source.binding });
      const identity = services.verifyIdentity({ source_ref: source.source_ref, name: input.name }); const relationship = services.verifyRelationship({ source_ref: source.source_ref, name: input.name });
      const output = { record_id: `rec_${source.source_ref}`, source_ref: source.source_ref, identity, relationship, recorded_at: services.recordedAt() }; records.push(output); return output; },
    supersede(input) { const output = { ...input, recorded_at: services.recordedAt() }; return output; },
    explain(query) { return { query, as_of_recorded: services.recordedAt(), status: [...sources.values()].every(source => services.isCurrentSource({ source_ref: source.source_ref, source_binding: source.binding })) ? "qualified" : "invalidated", records: [...records] }; },
  };
}
function recordingHistory(runRef, sourceRef, input) {
  const calls = []; const service = name => (...args) => { const result = name === "authorizeSource" ? { allowed: true, provenance: { decision_source: "authenticated_gateway", policy_version: "original", allowed_roles: ["cfo"] } } :
    name === "isCurrentSource" ? true : name === "recordedAt" ? "2026-09-08T00:00:00.000Z" : { verified: true, request_sha256: JSON.stringify(args[0]) }; calls.push({ method: name, args: structuredClone(args), result: structuredClone(result) }); return result; };
  const resolver = createMockResolver(Object.fromEntries(["authorizeSource", "isCurrentSource", "verifyPreparedSource", "verifyIdentity", "verifyRelationship", "verifySupersession", "recordedAt"].map(name => [name, service(name)]).concat([["callerLane", "cfo"]])));
  const capture = (operation, value, extra = {}) => { calls.length = 0; const output = resolver[operation](value); return { operation, input: structuredClone(value), calls: structuredClone(calls), output: structuredClone(output), ...extra }; };
  const registered = capture("registerSource", input); registered.input = null; registered.source_index = 0;
  const accepted = capture("accept", { source_ref: registered.output, name: input.binding.id });
  return { schema: "resolution-history-v1", run: runRef, caller_seat: "cfo", sources: [sourceRef], events: [registered, accepted], queries: [] };
}
function reader(runRef, producer, objects, state) {
  return { run_id: runRef.run_id, producer_id: producer, boundHistoryTrust: { store_id: "trusted", producer_ids: [producer] }, async readArtifact(artifact) {
    const payload = objects.get(JSON.stringify(artifact)); if (!payload) throw Object.assign(new Error("missing"), { code: "missing" });
    return { payload: structuredClone(payload), authority: { authenticated_gateway: true, policy_version: "policy-v1", expires_at: "2026-09-08T00:04:00.000Z", producer_id: producer, caller_seat: "cfo", current: state.current } };
  } };
}
function fixture() {
  const one = run("a"), two = run("b"), h1 = ref("1"), h2 = ref("2"), s1 = ref("3"), s2 = ref("4"), state = { current: true };
  const objects1 = new Map([[JSON.stringify(h1), recordingHistory(one, s1, { binding: { id: "one" } })], [JSON.stringify(s1), { schema: "resolution-source-input-v1", run: one, input: { binding: { id: "one" } } }]]);
  const objects2 = new Map([[JSON.stringify(h2), recordingHistory(two, s2, { binding: { id: "two" } })], [JSON.stringify(s2), { schema: "resolution-source-input-v1", run: two, input: { binding: { id: "two" } } }]]);
  return { one, two, h1, h2, state, readers: [reader(one, "producer-one", objects1, state), reader(two, "producer-two", objects2, state)] };
}
function recallFor(f) { return createCrossRunRecall({ createResolver: createMockResolver, bindPreparedSource, verificationRequestHash: value => JSON.stringify(value), readers: f.readers, now: () => Date.parse("2026-09-08T00:00:00.000Z") }); }

test("replays two immutable histories into one resolver without fresh verifier callbacks", async () => {
  const f = fixture(), recall = recallFor(f);
  const result = await recall.recall({ histories: [{ run: f.two, producer_id: "producer-two", artifact_ref: f.h2 }, { run: f.one, producer_id: "producer-one", artifact_ref: f.h1 }], query: { subject: "all" } });
  assert.equal(result.answer.status, "qualified"); assert.equal(result.answer.records.length, 2);
  assert.equal(result.answer.as_of_recorded, "2026-09-08T00:00:00.000Z");
  assert.deepEqual(result.history_refs, [f.h1, f.h2]);
});

test("a callback transcript mismatch and duplicate source are rejected", async () => {
  const f = fixture(); const history = await f.readers[0].readArtifact(f.h1); history.payload.events[1].calls[1].args[0].name = "tampered";
  const source = await f.readers[0].readArtifact(history.payload.sources[0]);
  const objects = new Map([[JSON.stringify(f.h1), history.payload], [JSON.stringify(history.payload.sources[0]), source.payload]]); f.readers[0] = reader(f.one, "producer-one", objects, f.state);
  await assert.rejects(recallFor(f).recall({ histories: [{ run: f.one, producer_id: "producer-one", artifact_ref: f.h1 }], query: {} }), { code: "cross_run_replay_divergence" });
});

test("final fresh authority change rederives and preserves history refs", async () => {
  const f = fixture(); let reads = 0;
  const originalReader = f.readers[0]; f.readers[0] = { ...originalReader, async readArtifact(refValue) { const output = await originalReader.readArtifact(refValue); if (++reads > 3) output.authority.current = false; return output; } };
  const recall = recallFor(f);
  const result = await recall.recall({ histories: [{ run: f.one, producer_id: "producer-one", artifact_ref: f.h1 }], query: {} });
  assert.equal(result.answer.status, "invalidated"); assert.deepEqual(result.history_refs, [f.h1]);
});

test("an authority that expires while artifacts are loading cannot reach explain", async () => {
  const f = fixture(); let calls = 0;
  const recall = createCrossRunRecall({ createResolver: createMockResolver, bindPreparedSource, verificationRequestHash: value => JSON.stringify(value), readers: f.readers,
    now: () => ++calls < 4 ? Date.parse("2026-09-08T00:00:00.000Z") : Date.parse("2026-09-08T00:05:00.000Z") });
  await assert.rejects(recall.recall({ histories: [{ run: f.one, producer_id: "producer-one", artifact_ref: f.h1 }], query: {} }), { code: "cross_run_authority_invalid" });
});
