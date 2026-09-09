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
 */
export function queryDurableHistory({ history, inputs, query, authorization, sourceCurrent, now = Date.now }) {
  if (!exact(history, ["schema", "run", "caller_seat", "sources", "events", "queries"]) || history.schema !== "resolution-history-v1" ||
      history.caller_seat !== "cfo" || !Array.isArray(inputs) || !inputs.length || inputs.length > LIMITS.sources ||
      !Array.isArray(history.events) || history.events.length > LIMITS.sources + 2 * LIMITS.assertions ||
      !authorization || authorization.allowed !== true || authorization.provenance?.decision_source !== "authenticated_gateway" ||
      !Array.isArray(authorization.provenance.allowed_roles) || !authorization.provenance.allowed_roles.includes("cfo") ||
      !utc(authorization.expires_at) || Date.parse(authorization.expires_at) <= now()) fail("durable_query_invalid");
  let frame = null, offset = 0, replaying = true, sourceIndex = 0;
  const services = { callerLane: "cfo" };
  for (const name of CALLBACKS) services[name] = (...args) => {
    if (replaying) {
      const recorded = frame?.calls?.[offset++];
      if (!recorded || recorded.method !== name || !equal(recorded.args, args)) fail("durable_query_replay_divergence");
      return clone(recorded.result);
    }
    if (name === "authorizeSource") return clone(authorization);
    if (name === "isCurrentSource") return sourceCurrent === true;
    if (name === "recordedAt") return new Date(now()).toISOString();
    fail("durable_query_replay_only_callback");
  };
  const resolver = createResolver(services);
  let records = 0, corrections = 0;
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
  replaying = false;
  return clone(query?.kind === "candidate_links" ? resolver.candidateLinks(clone(query)) : resolver.explain(clone(query)));
}
