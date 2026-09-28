import { canonical, sha256 } from "./aws-http.mjs";
import { createResolver, LIMITS } from "./resolver.mjs";

const CALLBACKS = ["authorizeSource", "isCurrentSource", "verifyPreparedSource", "verifyIdentity", "verifyRelationship", "verifySupersession", "recordedAt"];
const fail = code => { throw Object.assign(new Error(code), { code }); };
const clone = value => structuredClone(value);
const equal = (left, right) => canonical(left) === canonical(right);
const exact = (value, keys) => !!value && Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
const utc = value => typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;

/**
 * Replays an immutable resolution-history artifact through the production resolver.  This is
 * deliberately retrieval-only: verifier results are replayed receipts, while source currentness
 * and the policy authorization are supplied fresh by the gateway on every call.
 * @param {{entries: any[], query: any, now?: () => number, identityCurrentness?: Map<string, boolean> | null}} input
 */
function queryDurableHistoriesForSeats({ entries, query, now = Date.now, identityCurrentness = null }, allowedSeats) {
  if (!Array.isArray(entries) || !entries.length || entries.length > 64) fail("durable_query_invalid");
  const sourcesByRef = new Map(); let totalSources = 0, totalEvents = 0, callerLane = null;
  for (const entry of entries) {
    const { history, inputs, authorization, sourceCurrent } = entry ?? {};
    if (!exact(history, ["schema", "run", "caller_seat", "sources", "events", "queries"]) || history.schema !== "resolution-history-v1" ||
        !allowedSeats.includes(history.caller_seat) || (callerLane !== null && history.caller_seat !== callerLane) || !Array.isArray(inputs) || !inputs.length ||
        !Array.isArray(history.events) || !authorization || authorization.allowed !== true || authorization.provenance?.decision_source !== "authenticated_gateway" ||
        !Array.isArray(authorization.provenance.allowed_roles) || !authorization.provenance.allowed_roles.includes(history.caller_seat) ||
        !utc(authorization.expires_at) || Date.parse(authorization.expires_at) <= now() || typeof sourceCurrent !== "boolean") fail("durable_query_invalid");
    callerLane = history.caller_seat;
    totalSources += inputs.length; totalEvents += history.events.length;
    if (totalSources > LIMITS.sources || totalEvents > LIMITS.sources + 2 * LIMITS.assertions) fail("durable_query_limit");
    let inputIndex = 0;
    for (const event of history.events) if (event?.operation === "registerSource") {
      const input = inputs[inputIndex++];
      if (!input || typeof event.output !== "string" || sourcesByRef.has(event.output)) fail("durable_query_history_invalid");
      sourcesByRef.set(event.output, { binding: input.binding, authorization, sourceCurrent });
    }
    if (inputIndex !== inputs.length) fail("durable_query_history_invalid");
  }
  let frame = null, offset = 0, replaying = true; const identityProofs = [];
  const services = { callerLane, isCurrentIdentity: endpoint => identityCurrentness === null || identityCurrentness.get(endpoint?.proof?.request_sha256) === true };
  for (const name of CALLBACKS) services[name] = (...args) => {
    if (replaying) {
      const recorded = frame?.calls?.[offset++];
      if (!recorded || recorded.method !== name || !equal(recorded.args, args)) fail("durable_query_replay_divergence");
      if (name === "verifyIdentity" && recorded.result?.verified === true) identityProofs.push({ request: clone(args[0]), proof: clone(recorded.result) });
      return clone(recorded.result);
    }
    if (name === "recordedAt") return new Date(now()).toISOString();
    const source = sourcesByRef.get(args[0]?.source_ref);
    if (!source || !equal(args[0]?.source_binding, source.binding)) fail("durable_query_source_invalid");
    if (name === "authorizeSource") return clone(source.authorization);
    if (name === "isCurrentSource") return source.sourceCurrent;
    fail("durable_query_replay_only_callback");
  };
  const resolver = createResolver(services);
  let records = 0, corrections = 0;
  for (const {history,inputs} of entries) {
   let sourceIndex = 0;
   for (const event of history.events) {
    if (!exact(event, ["operation", "input", "calls", "output", ...(event.operation === "registerSource" ? ["source_index"] : [])]) ||
        !["registerSource", "accept", "supersede"].includes(event.operation) || !Array.isArray(event.calls) || event.calls.length > 4 * LIMITS.sources + 40) fail("durable_query_history_invalid");
    frame = event; offset = 0;
    let input = event.input;
    if (event.operation === "registerSource") {
      if (event.source_index !== sourceIndex || sourceIndex >= inputs.length || input !== null) fail("durable_query_history_invalid");
      input = inputs[sourceIndex++];
    } else if (event.operation === "accept") { if (++records > LIMITS.assertions) fail("durable_query_history_invalid"); }
    else if (++corrections > LIMITS.assertions) fail("durable_query_history_invalid");
    const output = resolver[event.operation](clone(input));
    if (offset !== event.calls.length || !equal(output, event.output)) fail("durable_query_replay_divergence");
   }
   if (sourceIndex !== inputs.length) fail("durable_query_history_invalid");
  }
  replaying = false;
  const answer = clone(query?.kind === "candidate_links" ? resolver.candidateLinks(clone(query)) : resolver.explain(clone(query)));
  Object.defineProperty(answer, "identityProofs", { value: identityProofs, enumerable: false }); return answer;
}

/** Existing finance and company-legal route. Keep its caller contract closed. */
export function queryDurableHistories(input) {
  return queryDurableHistoriesForSeats(input, ["cfo", "clo"]);
}

const HASH = /^[a-f0-9]{64}$/;
const SHARED_SYNTHETIC_BINDING = "company-shared-synthetic-chunk-binding-v1";
const SHARED_SYNTHETIC_INDEX = "company-shared-synthetic";
const citationKey = receipt => {
  const { citation_id: _citationId, ...identity } = receipt;
  return `cite_${sha256(canonical(identity))}`;
};

/**
 * Replays only the fixed-shape CTO company_shared synthetic contract. This adapter is not used by
 * the CFO/CLO publication service and accepts no client supplied history or store locator.
 * Currentness is checked around replay against the pinned citation receipt set.
 */
export function queryCompanySharedSyntheticHistories({ entries, query, now = Date.now, isCurrentCitation }) {
  if (!Array.isArray(entries) || !entries.length || entries.length > 4 || typeof isCurrentCitation !== "function") fail("shared_synthetic_query_invalid");
  const receipts = [];
  for (const entry of entries) {
    if (!exact(entry, ["history", "inputs", "authorization", "sourceCurrent", "citation_receipts"]) ||
        entry.history?.caller_seat !== "cto" || entry.history?.run?.scope !== "company_shared" ||
        !Array.isArray(entry.inputs) || !entry.inputs.length || !Array.isArray(entry.citation_receipts) ||
        entry.citation_receipts.length !== entry.inputs.length) fail("shared_synthetic_partition_invalid");
    for (let i = 0; i < entry.inputs.length; i++) {
      const input = entry.inputs[i], binding = input?.binding, receipt = entry.citation_receipts[i];
      if (binding?.schema !== SHARED_SYNTHETIC_BINDING || binding.room !== "company_shared" || binding.source_index !== SHARED_SYNTHETIC_INDEX ||
          !exact(receipt, ["schema", "source_group", "source_id", "source_version", "provenance_receipt_sha256", "citation_id"]) ||
          receipt.schema !== "company-shared-citation-receipt-v1" || receipt.source_group !== "company_shared" ||
          !HASH.test(receipt.source_id ?? "") || !HASH.test(receipt.provenance_receipt_sha256 ?? "") ||
          receipt.source_version !== `sha256:${binding.chunk_sha256}` || !HASH.test(binding.chunk_sha256 ?? "") ||
          receipt.citation_id !== citationKey(receipt)) fail("shared_synthetic_citation_invalid");
      receipts.push(receipt);
    }
  }
  const readCurrent = receipt => {
    try { return isCurrentCitation(structuredClone(receipt)) === true; }
    catch { return false; }
  };
  const before = receipts.map(readCurrent);
  const replayEntries = entries.map((entry, index) => ({ ...entry, sourceCurrent: before.slice(index * entry.inputs.length, (index + 1) * entry.inputs.length).every(Boolean) }));
  const answer = queryDurableHistoriesForSeats({ entries: replayEntries, query, now }, ["cto"]);
  const after = receipts.map(readCurrent);
  if (before.some((value, index) => value !== after[index])) fail("shared_synthetic_currentness_changed");
  const byVersion = new Map(receipts.filter((_, index) => before[index]).map(receipt => [receipt.source_version, receipt]));
  const citations = (answer.evidence ?? []).map(record => {
    const version = `sha256:${record.evidence?.source_binding?.chunk_sha256 ?? ""}`;
    const receipt = byVersion.get(version);
    return receipt ? { source_id: receipt.source_id, source_version: receipt.source_version, citation_id: receipt.citation_id, provenance_receipt_sha256: receipt.provenance_receipt_sha256 } : null;
  }).filter(Boolean);
  return { ...answer, query_scope: "company_shared", synthetic_only: true, citations };
}

export function queryDurableHistory(input) { return queryDurableHistories({entries:[input],query:input.query,now:input.now}); }
