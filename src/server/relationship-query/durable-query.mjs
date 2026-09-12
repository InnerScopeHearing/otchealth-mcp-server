import { canonical } from "./aws-http.mjs";
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
export function queryDurableHistories({ entries, query, now = Date.now, identityCurrentness = null }) {
  if (!Array.isArray(entries) || !entries.length || entries.length > 64) fail("durable_query_invalid");
  const sourcesByRef = new Map(); let totalSources = 0, totalEvents = 0;
  for (const entry of entries) {
    const { history, inputs, authorization, sourceCurrent } = entry ?? {};
    if (!exact(history, ["schema", "run", "caller_seat", "sources", "events", "queries"]) || history.schema !== "resolution-history-v1" ||
        !["cfo", "clo"].includes(history.caller_seat) || !Array.isArray(inputs) || !inputs.length ||
        !Array.isArray(history.events) || !authorization || authorization.allowed !== true || authorization.provenance?.decision_source !== "authenticated_gateway" ||
        !Array.isArray(authorization.provenance.allowed_roles) || !authorization.provenance.allowed_roles.includes(history.caller_seat) ||
        !utc(authorization.expires_at) || Date.parse(authorization.expires_at) <= now() || typeof sourceCurrent !== "boolean") fail("durable_query_invalid");
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
  const callerLane = entries[0].history.caller_seat;
  if (entries.some(entry => entry.history.caller_seat !== callerLane)) fail("durable_query_invalid");
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

export function queryDurableHistory(input) { return queryDurableHistories({entries:[input],query:input.query,now:input.now}); }
