const HISTORY_SCHEMA = "resolution-history-v1";
const SOURCE_SCHEMA = "resolution-source-input-v1";
const CALLBACKS = ["authorizeSource", "isCurrentSource", "verifyPreparedSource", "verifyIdentity", "verifyRelationship", "verifySupersession", "recordedAt"];
const fail = code => { throw Object.assign(new Error(code), { code }); };
const canonical = value => value === null || typeof value !== "object" ? JSON.stringify(value) : Array.isArray(value)
  ? `[${value.map(canonical).join(",")}]` : `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
const clone = value => { try { return structuredClone(value); } catch { fail("cross_run_history_invalid"); } };
const equal = (left, right) => canonical(left) === canonical(right);
const exact = (value, keys) => !!value && Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
const utc = value => typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
function active(signal) { if (signal?.aborted) fail("cross_run_recall_cancelled"); }
function frozen(value) { const copy = clone(value); const visit = item => { if (item && typeof item === "object") { Object.values(item).forEach(visit); Object.freeze(item); } }; visit(copy); return copy; }
function validAuthority(authority, reader, at) {
  if (!Number.isFinite(at)) fail("cross_run_clock_invalid");
  if (!exact(authority, ["authenticated_gateway", "policy_version", "expires_at", "producer_id", "caller_seat", "current"]) ||
      authority.authenticated_gateway !== true || authority.producer_id !== reader.producer_id || authority.caller_seat !== "cfo" ||
      typeof authority.policy_version !== "string" || !authority.policy_version || !utc(authority.expires_at) ||
      Date.parse(authority.expires_at) <= at || Date.parse(authority.expires_at) - at > 300000 || typeof authority.current !== "boolean") fail("cross_run_authority_invalid");
  return frozen(authority);
}
function readerKey(runId, producer) { return `${runId}\0${producer}`; }
function artifactKey(ref) { return canonical(ref); }
function validReader(reader) {
  return !!reader && typeof reader.readArtifact === "function" && typeof reader.run_id === "string" && /^run_[a-f0-9]{64}$/.test(reader.run_id) &&
    typeof reader.producer_id === "string" && /^[a-z][a-z0-9-]{0,63}$/.test(reader.producer_id) && reader.boundHistoryTrust && typeof reader.boundHistoryTrust.store_id === "string" &&
    Array.isArray(reader.boundHistoryTrust.producer_ids) && reader.boundHistoryTrust.producer_ids.includes(reader.producer_id);
}
function validHistory(value, run) {
  if (!exact(value, ["schema", "run", "caller_seat", "sources", "events", "queries"]) || value.schema !== HISTORY_SCHEMA ||
      !equal(value.run, run) || value.caller_seat !== "cfo" || !Array.isArray(value.sources) || !Array.isArray(value.events) || !Array.isArray(value.queries) ||
      value.sources.length > 64 || value.events.length > 640 || value.queries.length > 100 || new Set(value.sources.map(artifactKey)).size !== value.sources.length) fail("cross_run_history_invalid");
}

/**
 * Retrieval only. It never calls a new identity, semantic, lineage, or supersession verifier.
 * Every reader is fixed at construction and must be an authenticated, run-bound gateway reader.
 */
export function createCrossRunRecall({ createResolver, bindPreparedSource, verificationRequestHash, readers, now = Date.now } = {}) {
  if (typeof createResolver !== "function" || typeof bindPreparedSource !== "function" || typeof verificationRequestHash !== "function" ||
      !Array.isArray(readers) || !readers.length || readers.length > 64 || readers.some(reader => !validReader(reader)) || typeof now !== "function") fail("cross_run_configuration");
  const fixedReaders = new Map();
  for (const reader of readers) {
    const key = readerKey(reader.run_id, reader.producer_id);
    if (fixedReaders.has(key)) fail("cross_run_configuration");
    fixedReaders.set(key, Object.freeze(reader));
  }
  async function read(reader, ref, signal, options) {
    active(signal); let result;
    try { result = await reader.readArtifact(frozen(ref), { signal }); } catch (error) { if (error?.code) throw error; fail("cross_run_reader_failed"); }
    active(signal);
    if (!result || !Object.hasOwn(result, "payload") || !Object.hasOwn(result, "authority")) fail("cross_run_reader_invalid");
    return { payload: frozen(result.payload), authority: validAuthority(result.authority, reader, now()) };
  }
  async function loadHistories(entries, signal) {
    if (!Array.isArray(entries) || !entries.length || entries.length > 64) fail("cross_run_request_invalid");
    const seen = new Set(), loaded = [];
    for (const raw of entries) {
      active(signal);
      if (!exact(raw, ["run", "producer_id", "artifact_ref"]) || !raw.run || typeof raw.run.run_id !== "string" || typeof raw.producer_id !== "string") fail("cross_run_request_invalid");
      const reader = fixedReaders.get(readerKey(raw.run.run_id, raw.producer_id));
      if (!reader || !equal(raw.run_id ?? raw.run.run_id, reader.run_id) || !reader.boundHistoryTrust.producer_ids.includes(raw.producer_id)) fail("cross_run_reader_untrusted");
      const id = `${readerKey(reader.run_id, raw.producer_id)}\0${artifactKey(raw.artifact_ref)}`;
      if (seen.has(id)) fail("cross_run_history_duplicate"); seen.add(id);
      const result = await read(reader, raw.artifact_ref, signal, { history: true });
      validHistory(result.payload, raw.run);
      loaded.push({ reader, entry: frozen(raw), history: result.payload });
    }
    return loaded.sort((left, right) => left.reader.run_id.localeCompare(right.reader.run_id) || left.reader.producer_id.localeCompare(right.reader.producer_id) || artifactKey(left.entry.artifact_ref).localeCompare(artifactKey(right.entry.artifact_ref)));
  }
  async function sourceInputs(loaded, signal) {
    const usedRefs = new Set(), usedSources = new Set(), all = [];
    for (const item of loaded) for (const ref of item.history.sources) {
      const refId = `${readerKey(item.reader.run_id, item.reader.producer_id)}\0${artifactKey(ref)}`;
      if (usedRefs.has(refId)) fail("cross_run_source_duplicate"); usedRefs.add(refId);
      const result = await read(item.reader, ref, signal, { history: false });
      if (!exact(result.payload, ["schema", "run", "input"]) || result.payload.schema !== SOURCE_SCHEMA || !equal(result.payload.run, item.entry.run)) fail("cross_run_history_invalid");
      let bound; try { bound = bindPreparedSource(result.payload.input); } catch { fail("cross_run_source_invalid"); }
      if (!bound || typeof bound.source_ref !== "string" || usedSources.has(bound.source_ref)) fail("cross_run_source_duplicate");
      usedSources.add(bound.source_ref); all.push({ ...item, ref: frozen(ref), input: frozen(result.payload.input), bound: frozen(bound), authority: result.authority });
    }
    return all;
  }
  function replay(loaded, sources) {
    const byHistory = new Map(loaded.map(item => [item, sources.filter(source => source.history === item.history)]));
    let frame = null, callOffset = 0, replaying = true;
    const live = new Map(sources.map(source => [source.bound.source_ref, source]));
    const services = { callerLane: "cfo" };
    for (const name of CALLBACKS) services[name] = (...args) => {
      if (replaying) {
        const call = frame?.calls?.[callOffset++];
        if (!call || call.method !== name || !equal(call.args, args)) fail("cross_run_replay_divergence");
        if (["verifyPreparedSource", "verifyIdentity", "verifyRelationship", "verifySupersession"].includes(name) && call.result?.verified === true) {
          let requestHash; try { requestHash = verificationRequestHash(args[0]); } catch { fail("cross_run_replay_divergence"); }
          if (call.result.request_sha256 !== requestHash) fail("cross_run_replay_divergence");
        }
        return clone(call.result);
      }
      if (name === "authorizeSource") {
        const source = live.get(args[0]?.source_ref);
        if (!source || !equal(args[0]?.source_binding, source.bound.binding)) fail("cross_run_source_invalid");
        return { allowed: true, provenance: { decision_source: "authenticated_gateway", policy_version: source.authority.policy_version, allowed_roles: ["cfo"] },
          decision_ref: `gateway-policy:${source.authority.producer_id}:${source.authority.policy_version}`, expires_at: source.authority.expires_at };
      }
      if (name === "isCurrentSource") { const source = live.get(args[0]?.source_ref); if (!source) fail("cross_run_source_invalid"); return source.authority.current; }
      if (name === "recordedAt") { const at = now(); if (!Number.isFinite(at)) fail("cross_run_clock_invalid"); return new Date(at).toISOString(); }
      fail("cross_run_replay_only_callback");
    };
    const resolver = createResolver(services);
    for (const item of loaded) {
      let index = 0;
      for (const event of item.history.events) {
        if (!exact(event, ["operation", "input", "calls", "output", ...(event.operation === "registerSource" ? ["source_index"] : [])]) ||
            !["registerSource", "accept", "supersede"].includes(event.operation) || !Array.isArray(event.calls) || event.calls.length > 300) fail("cross_run_history_invalid");
        frame = event; callOffset = 0; let input = event.input;
        if (event.operation === "registerSource") {
          const local = byHistory.get(item); if (event.source_index !== index || !local[index] || input !== null) fail("cross_run_history_invalid");
          input = local[index++].input;
        }
        let output; try { output = resolver[event.operation](clone(input)); } catch (error) { if (error?.code) throw error; fail("cross_run_replay_divergence"); }
        if (callOffset !== event.calls.length || !equal(output, event.output)) fail("cross_run_replay_divergence");
      }
      if (index !== byHistory.get(item).length) fail("cross_run_history_invalid");
    }
    replaying = false;
    return resolver;
  }
  async function refreshSources(sources, signal) {
    const refreshed = [];
    for (const source of sources) {
      const result = await read(source.reader, source.ref, signal, { history: false });
      if (!exact(result.payload, ["schema", "run", "input"]) || result.payload.schema !== SOURCE_SCHEMA || !equal(result.payload.input, source.input)) fail("cross_run_source_changed");
      refreshed.push({ ...source, authority: result.authority });
    }
    return refreshed;
  }
  function assertFresh(sources) {
    const at = now();
    if (!Number.isFinite(at)) fail("cross_run_clock_invalid");
    for (const source of sources) validAuthority(source.authority, source.reader, at);
  }
  return Object.freeze({
    async recall({ histories, query }, { signal } = {}) {
      active(signal); const loaded = await loadHistories(clone(histories), signal); const originalSources = await sourceInputs(loaded, signal);
      let sources = await refreshSources(originalSources, signal); assertFresh(sources);
      let resolver = replay(loaded, sources); let answer = (query?.kind==='candidate_links'?resolver.candidateLinks(clone(query)):resolver.explain(clone(query)));
      // Last boundary: re-open each history and source through the authenticated gateway. No result survives a revoked history access.
      const finalHistories = await loadHistories(loaded.map(item => item.entry), signal);
      if (finalHistories.length !== loaded.length || finalHistories.some((item, index) => !equal(item.history, loaded[index].history))) fail("cross_run_history_changed");
      const finalSources = await refreshSources(sources, signal); assertFresh(finalSources);
      if (!equal(sources.map(source => source.authority), finalSources.map(source => source.authority))) { sources = finalSources; resolver = replay(loaded, sources); assertFresh(sources); answer = (query?.kind==='candidate_links'?resolver.candidateLinks(clone(query)):resolver.explain(clone(query))); }
      active(signal);
      return frozen({ schema: "cross-run-resolution-recall-v1", answer, history_refs: loaded.map(item => clone(item.entry.artifact_ref)) });
    },
  });
}
