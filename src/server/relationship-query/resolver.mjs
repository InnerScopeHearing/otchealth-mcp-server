import { canonical, sha256 } from "./aws-http.mjs";
import { documentVersion, createTypedSemanticAssertion, validTime } from "./graph-assertion-contract.mjs";
import { preparedTextIdentity, validatePreparedTextBinding } from "./prepared-text-binding.mjs";
import { parseIdentityCurrentnessPointer } from "./identity-currentness-proof.mjs";

export const SCHEMA = "relationship-resolution-v1";
// Match the complete prepared-text contract. Chunks remain 16 KiB; never truncate a document to fit.
export const LIMITS = Object.freeze({ sources: 100, assertions: 400, source_bytes: 1024 * 1024, query_depth: 4 });
const fail = code => { throw Object.assign(new Error(code), { code }); };
const bounded = value => typeof value === "string" && value.trim().length > 0 && value.length <= 1200 && !value.includes("\0");
const id = (kind, value) => `${kind}_${sha256(canonical(value))}`;
function freeze(value, ancestors = new WeakSet()) {
  if (value && typeof value === "object") {
    if (ancestors.has(value)) fail("cyclic_input");
    ancestors.add(value); Object.values(value).forEach(child => freeze(child, ancestors)); ancestors.delete(value); Object.freeze(value);
  }
  return value;
}
const copy = value => freeze(structuredClone(value));
export const verificationRequestHash = value => sha256(canonical(value));
function verifiedProof(proof, request) {
  return proof?.verified === true && proof.request_sha256 === verificationRequestHash(request) &&
    bounded(proof.verifier_id) && bounded(proof.verifier_version) && bounded(proof.basis);
}
const keepProof = proof => {
  const identityCurrentness = parseIdentityCurrentnessPointer(proof.identity_currentness, proof.request_sha256);
  return copy({ request_sha256: proof.request_sha256, verifier_id: proof.verifier_id, verifier_version: proof.verifier_version, basis: proof.basis,
    ...(proof.epistemic_status === "source_attributed" ? { epistemic_status: "source_attributed" } : {}),
    ...(identityCurrentness ? { identity_currentness: identityCurrentness } : {}) });
};
const exactPlain = (value, keys) => !!value && Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).sort().join() === [...keys].sort().join();
function utc(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
function boundary(text, offset) {
  return Number.isSafeInteger(offset) && offset >= 0 && offset <= text.length &&
    !(offset > 0 && offset < text.length && /[\uD800-\uDBFF]/.test(text[offset - 1]) && /[\uDC00-\uDFFF]/.test(text[offset]));
}
function uncertainty(value) {
  if (!value || !["unknown", "low", "medium", "high"].includes(value.level) || !Array.isArray(value.qualifications) ||
      value.qualifications.length > 12 || value.qualifications.some(x => !bounded(x))) fail("uncertainty_required");
  return copy({ level: value.level, qualifications: [...new Set(value.qualifications)].sort() });
}

/** Scoped, case-sensitive identifiers only. No fuzzy matching or namespace aliases. */
export function stableEntityId(endpoint) {
  if (!exactPlain(endpoint, ["display_name", "entity_type", "identifier"]) || !bounded(endpoint.display_name) || !bounded(endpoint.entity_type) ||
      !exactPlain(endpoint.identifier, ["namespace", "scope", "value"]) ||
      ["namespace", "scope", "value"].some(k => !bounded(endpoint.identifier[k]))) fail("stable_identifier_required");
  return id("entity", { entity_type: endpoint.entity_type, namespace: endpoint.identifier.namespace,
    scope: endpoint.identifier.scope, value: endpoint.identifier.value });
}

/** Trusted adapter supplies an immutable catalog row plus the complete prepared text for local validation. */
export function bindPreparedSource({ binding: raw, catalog_row, prepared_text, chunk_start_utf16, chunk_end_utf16, purpose }) {
  const binding = validatePreparedTextBinding(raw);
  const catalog = documentVersion(catalog_row, binding.room);
  if (catalog.document_version_id !== binding.source_document_version || catalog.source_version !== binding.catalog_source_sha256 ||
      typeof prepared_text !== "string" || !prepared_text.length || Buffer.byteLength(prepared_text) > LIMITS.source_bytes ||
      Buffer.from(prepared_text).toString("utf8") !== prepared_text || sha256(prepared_text) !== binding.sidecar_content_sha256 ||
      !boundary(prepared_text, chunk_start_utf16) || !boundary(prepared_text, chunk_end_utf16) || chunk_end_utf16 <= chunk_start_utf16 ||
      (binding.chunk_ordinal === 0 && chunk_start_utf16 !== 0)) fail("source_binding_mismatch");
  const text = prepared_text.slice(chunk_start_utf16, chunk_end_utf16);
  if (text.length > 16000 || Buffer.byteLength(text) > 16384 || sha256(text) !== binding.chunk_sha256) fail("source_binding_mismatch");
  const identity = preparedTextIdentity({ source_binding: binding, purpose });
  // This document's bytes are the prepared text chunk, never the catalog-associated binary.
  const textDocument = documentVersion({ path: `prepared/${catalog.source_path_hash}/${binding.snapshot_id}/${binding.chunk_ordinal}.txt`,
    sha256: binding.chunk_sha256, sidecar: true, enriched: true, enriched_sha256: binding.chunk_sha256 }, binding.room);
  return copy({ source_ref: id("source", { binding, purpose }), binding, purpose, identity, catalog, text_document: textDocument, text,
    chunk_start_utf16, chunk_start_byte: Buffer.byteLength(prepared_text.slice(0, chunk_start_utf16)),
    lineage: { original: { status: "catalog_association_only", document_version_id: catalog.document_version_id,
      source_sha256: catalog.source_version, source_path_hash: catalog.source_path_hash },
    prepared_text: { status: "hash_checked_text_candidate", snapshot_id: binding.snapshot_id, sidecar_content_sha256: binding.sidecar_content_sha256,
      prepared_manifest_sha256: binding.prepared_manifest_sha256, chunk_sha256: binding.chunk_sha256 } } });
}

function locate(candidate, source) {
  if (!candidate || ["subject", "predicate", "object", "quote"].some(k => !bounded(candidate[k])) ||
      candidate.state !== "candidate" || candidate.semantic_verified !== false ||
      candidate.document_version_id !== source.identity.source_version || candidate.source_sha256 !== source.binding.chunk_sha256)
    fail("candidate_binding_invalid");
  const start = candidate.evidence_start_utf16, end = candidate.evidence_end_utf16;
  if (!boundary(source.text, start) || !boundary(source.text, end) || end <= start || source.text.slice(start, end) !== candidate.quote)
    fail("candidate_span_invalid");
  if (source.text.indexOf(candidate.quote) !== source.text.lastIndexOf(candidate.quote)) fail("candidate_quote_ambiguous");
  const startByte = Buffer.byteLength(source.text.slice(0, start)), endByte = Buffer.byteLength(source.text.slice(0, end));
  return copy({ passage: candidate.quote, passage_sha256: sha256(candidate.quote), source_ref: source.source_ref,
    source_binding: source.binding, lineage: source.lineage,
    chunk_start_utf16: start, chunk_end_utf16: end, chunk_start_byte: startByte, chunk_end_byte: endByte,
    text_start_utf16: source.chunk_start_utf16 + start, text_end_utf16: source.chunk_start_utf16 + end,
    text_start_byte: source.chunk_start_byte + startByte, text_end_byte: source.chunk_start_byte + endByte });
}

const overlaps = (a, b) => Math.max(a.valid_from ? Date.parse(a.valid_from) : -Infinity, b.valid_from ? Date.parse(b.valid_from) : -Infinity) <
  Math.min(a.valid_to ? Date.parse(a.valid_to) : Infinity, b.valid_to ? Date.parse(b.valid_to) : Infinity);
const within = (time, at) => (!time.valid_from || Date.parse(time.valid_from) <= Date.parse(at)) && (!time.valid_to || Date.parse(at) < Date.parse(time.valid_to));

/**
 * Local synchronous acceptance engine. Dependencies are trusted code, never model output.
 * No network, persistence, global registry, credential handling, or default verifier.
 * Callbacks must be synchronous; Promise-shaped decisions fail closed.
 */
export function createResolver(services) {
  if (!services || !bounded(services.callerLane) || ["authorizeSource", "isCurrentSource", "verifyPreparedSource", "verifyIdentity", "verifyRelationship", "recordedAt"]
    .some(k => typeof services[k] !== "function")) fail("trusted_services_required");
  const sources = new Map(), records = new Map(), reviewDecisions = new Map(), corrections = new Map();
  function permission(source) {
    const decision = services.authorizeSource(copy({ caller_lane: services.callerLane, source_ref: source.source_ref, source_binding: source.binding }));
    const p = decision?.provenance;
    if (decision?.allowed !== true || p?.decision_source !== "authenticated_gateway" || !bounded(p.policy_version) ||
        !Array.isArray(p.allowed_roles) || !p.allowed_roles.includes(services.callerLane) || p.allowed_roles.some(x => !bounded(x))) fail("source_not_authorized");
    return copy(decision);
  }
  function sourceFor(ref) { const source = sources.get(ref); if (!source) fail("source_missing"); permission(source); return source; }
  function clock() { const at = services.recordedAt(); if (!utc(at)) fail("recorded_time_invalid"); return at; }
  function identity(endpoint, name, context) {
    if (!endpoint || endpoint.display_name !== name || !bounded(endpoint.entity_type)) fail("endpoint_invalid");
    if (endpoint.identifier === undefined || endpoint.identifier === null) return copy({ status: "unresolved", display_name: name,
      entity_id: id("mention", { source_ref: context.source_ref, candidate_id: context.candidate_id, side: context.side }), reason: "name_only" });
    const entityId = stableEntityId(endpoint);
    const request = copy({ ...context, endpoint, entity_id: entityId });
    const proof = services.verifyIdentity(request);
    if (!verifiedProof(proof, request))
      return copy({ status: "unresolved", display_name: name, entity_id: id("mention", { candidate_id: context.candidate_id, side: context.side }), reason: "identifier_unverified" });
    return copy({ status: "resolved", entity_id: entityId, display_name: name, entity_type: endpoint.entity_type,
      identifier: endpoint.identifier, proof: keepProof(proof) });
  }
  function view({ as_of_recorded = clock(), valid_at = null } = {}) {
    if (!utc(as_of_recorded) || (valid_at !== null && !utc(valid_at))) fail("query_time_invalid");
    const state = new Map();
    // Fail closed for the entire bounded query if any retained source is denied, including historical/conflicting evidence.
    const current = new Map([...sources].map(([ref, source]) => { permission(source);
      return [ref, services.isCurrentSource(copy({ source_ref: ref, source_binding: source.binding })) === true]; }));
    for (let record of records.values()) if (record.recorded_at <= as_of_recorded) {
      const sourceCurrent = current.get(record.evidence.source_ref);
      const identityCurrent = endpoint => endpoint.status !== "resolved" || (sourceCurrent &&
        (!services.isCurrentIdentity || services.isCurrentIdentity(endpoint) === true));
      if (!identityCurrent(record.subject) || !identityCurrent(record.object)) record = {
        ...record, accepted: false, assertion: null, verification: null, identity_verified: false,
        uncertainty: { level: "unknown", qualifications: [...new Set([...record.uncertainty.qualifications,
          "Current identity authority is unavailable or no longer verifies the saved receipt."])] },
      };
      state.set(record.record_id, { record, status: !sourceCurrent ? "stale" : record.accepted ? "accepted" : "candidate", conflicts: [] });
    }
    const visibleCorrections = new Map([...corrections].filter(([, c]) => c.recorded_at <= as_of_recorded));
    for (const [targetId, correction] of visibleCorrections) {
      const target = state.get(targetId), trace = [], visited = new Set([targetId]);
      let terminal = targetId;
      while (visibleCorrections.has(terminal)) {
        const step = visibleCorrections.get(terminal);
        terminal = step.replacement_id;
        if (visited.has(terminal)) fail("supersession_cycle");
        visited.add(terminal); trace.push(step);
      }
      if (target && state.has(terminal)) {
        target.status = !current.get(state.get(terminal).record.evidence.source_ref) ? "supersession_replacement_stale" : "superseded";
        target.correction = correction; target.correction_trace = trace; target.terminal_replacement_id = terminal;
      }
    }
    const live = [...state.values()].filter(x => x.status === "accepted");
    for (let i = 0; i < live.length; i++) for (let j = i + 1; j < live.length; j++) {
      const a = live[i], b = live[j];
      if (a.record.claim_key === b.record.claim_key && a.record.polarity !== b.record.polarity && overlaps(a.record.valid_time, b.record.valid_time)) {
        // With a valid-time query, only concurrent evidence at that instant conflicts.
        if (valid_at && !(within(a.record.valid_time, valid_at) && within(b.record.valid_time, valid_at))) continue;
        a.conflicts.push(b.record.record_id); b.conflicts.push(a.record.record_id);
      }
    }
    return [...state.values()].map(x => copy({ ...x.record, status: x.conflicts.length ? "conflicted" :
      valid_at && x.status === "accepted" && !within(x.record.valid_time, valid_at) ? "outside_valid_time" : x.status,
      conflicting_record_ids: x.conflicts.sort(), correction: x.correction ?? null, correction_trace: x.correction_trace ?? [],
      terminal_replacement_id: x.terminal_replacement_id ?? null })).sort((a, b) => a.record_id.localeCompare(b.record_id));
  }
  return Object.freeze({
    registerSource(input) {
      const candidateSource = bindPreparedSource(input);
      permission(candidateSource);
      // Trusted adapter must compare this exact request with active run, manifest, snapshot and chunk receipts.
      const request = copy({ caller_lane: services.callerLane, source: candidateSource });
      const proof = services.verifyPreparedSource(request);
      if (!verifiedProof(proof, request)) fail("prepared_lineage_unverified");
      const source = copy({ ...candidateSource, lineage: { ...candidateSource.lineage,
        prepared_text: { ...candidateSource.lineage.prepared_text, status: "verified_text_lineage", verification: keepProof(proof) } } });
      permission(source);
      if (services.isCurrentSource(copy({ source_ref: source.source_ref, source_binding: source.binding })) !== true) fail("source_stale");
      if (!sources.has(source.source_ref) && sources.size >= LIMITS.sources) fail("source_limit");
      const previous = sources.get(source.source_ref);
      if (previous && canonical(previous) !== canonical(source)) fail("source_replay_conflict");
      sources.set(source.source_ref, source);
      return source.source_ref;
    },
    accept(input) {
      const source = sourceFor(input?.source_ref);
      if (services.isCurrentSource(copy({ source_ref: source.source_ref, source_binding: source.binding })) !== true) fail("source_stale");
      const candidate = copy(input.candidate), evidence = locate(candidate, source);
      const doubt = uncertainty(input.uncertainty), validity = validTime(input.valid_time);
      if ([validity.valid_from_basis, validity.valid_to_basis].some(x => !["unknown", "exact_witness"].includes(x))) fail("valid_time_support_required");
      if (!["positive", "negative"].includes(input.polarity)) fail("polarity_required");
      const candidateId = id("candidate", { candidate, evidence });
      const reviewAdmissionId = id("review_admission", {
        candidate_id: candidateId,
        subject: copy(input.subject),
        object: copy(input.object),
        polarity: input.polarity,
        uncertainty: doubt,
        valid_time: validity,
      });
      const previousRecordId = reviewDecisions.get(reviewAdmissionId);
      if (previousRecordId) return records.get(previousRecordId);
      const context = { source_ref: source.source_ref, candidate_id: candidateId, candidate, evidence };
      const subject = identity(input.subject, candidate.subject, { ...context, side: "subject" });
      const object = identity(input.object, candidate.object, { ...context, side: "object" });
      const claimKey = id("claim", { subject: subject.entity_id, predicate: candidate.predicate, object: object.entity_id });
      const intent = { candidate, evidence, subject, object, polarity: input.polarity, uncertainty: doubt, valid_time: validity };
      const recordId = id("resolution", intent);
      if (records.has(recordId)) return records.get(recordId);
      if (records.size >= LIMITS.assertions) fail("assertion_limit");
      const at = clock();
      const request = copy({ ...context, subject, object, polarity: input.polarity, valid_time: validity, uncertainty: doubt });
      const decision = subject.status === "resolved" && object.status === "resolved" ? services.verifyRelationship(request) : null;
      const accepted = verifiedProof(decision, request);
      if (accepted && Object.hasOwn(decision, "epistemic_status") && decision.epistemic_status !== "source_attributed") fail("epistemic_status_invalid");
      const attributed = accepted && decision.epistemic_status === "source_attributed";
      let assertion = null;
      // The existing contract governs positive fact admission, byte witnesses, permissions and endpoint resolution.
      if (accepted && !attributed && input.polarity === "positive") assertion = createTypedSemanticAssertion({
        document_version_id: source.text_document.document_version_id, subject_id: subject.entity_id, object_id: object.entity_id,
        predicate: candidate.predicate, assertion_class: "fact", span_start_byte: evidence.chunk_start_byte,
        span_end_byte: evidence.chunk_end_byte, valid_time: validity }, Buffer.from(source.text), {
        callerLane: services.callerLane, lookupDocumentVersion: () => source.text_document,
        authorizeDocument: () => {
          if (services.isCurrentSource(copy({ source_ref: source.source_ref, source_binding: source.binding })) !== true) fail("source_stale");
          return permission(source);
        }, resolveEndpoint: entity_id => ({ status: "resolved", entity_id, registry_version: SCHEMA }),
        recordedAt: () => at, verifyFact: () => ({ verified: true, verifier_id: decision.verifier_id,
          verifier_version: decision.verifier_version, verification_basis: decision.basis }) });
      // Negative evidence remains a typed resolution record; it is never emitted as a positive graph assertion.
      if (accepted && (attributed || input.polarity === "negative") && !["party_to", "signatory_of", "owns", "controls", "obligated_to", "amends", "supersedes", "depends_on"].includes(candidate.predicate)) fail("typed_predicate");
      const record = copy({ schema: SCHEMA, record_id: recordId, candidate_id: candidateId, ...intent, claim_key: claimKey,
        accepted, verification: accepted ? keepProof(decision) : null,
        ...(attributed ? { epistemic_status: "source_attributed" } : {}),
        ...(decision?.request_sha256 === verificationRequestHash(request) && decision.review ? { review: copy(decision.review) } : {}),
        assertion, recorded_at: at });
      permission(source);
      if (services.isCurrentSource(copy({ source_ref: source.source_ref, source_binding: source.binding })) !== true) fail("source_stale");
      records.set(recordId, record);
      reviewDecisions.set(reviewAdmissionId, recordId);
      return record;
    },
    supersede({ target_id, replacement_id }) {
      const target = records.get(target_id), replacement = records.get(replacement_id);
      if (!target || !replacement || target_id === replacement_id || !target.accepted || !replacement.accepted ||
          target.claim_key !== replacement.claim_key || typeof services.verifySupersession !== "function") fail("supersession_invalid");
      if (corrections.has(target_id)) {
        sourceFor(target.evidence.source_ref); sourceFor(replacement.evidence.source_ref);
        const existing = corrections.get(target_id);
        if (existing.replacement_id !== replacement_id) fail("supersession_conflict");
        if (services.isCurrentSource(copy({ source_ref: replacement.evidence.source_ref, source_binding: replacement.evidence.source_binding })) !== true) fail("source_stale");
        return existing;
      }
      const states = view();
      if (!states.some(x => x.record_id === replacement_id && ["accepted", "conflicted"].includes(x.status)) ||
          !states.some(x => x.record_id === target_id && ["accepted", "conflicted", "stale"].includes(x.status))) fail("supersession_invalid");
      // A replacement already pointing back to target would create a cycle.
      let cursor = replacement_id;
      while (corrections.has(cursor)) { cursor = corrections.get(cursor).replacement_id; if (cursor === target_id) fail("supersession_cycle"); }
      const request = copy({ target, replacement });
      const proof = services.verifySupersession(request);
      if (!verifiedProof(proof, request)) fail("supersession_unverified");
      const at = clock();
      if (at <= target.recorded_at || at <= replacement.recorded_at) fail("supersession_time_order");
      const correction = copy({ correction_id: id("correction", { target_id, replacement_id }), target_id, replacement_id,
        recorded_at: at, proof: keepProof(proof) });
      sourceFor(target.evidence.source_ref); sourceFor(replacement.evidence.source_ref);
      if (services.isCurrentSource(copy({ source_ref: replacement.evidence.source_ref, source_binding: replacement.evidence.source_binding })) !== true) fail("source_stale");
      corrections.set(target_id, correction); return correction;
    },
    records: view,
    candidateLinks(query) {
      const keys = ["kind", "subject_name", "object_name", "predicate", "offset", "limit", "include_stale"];
      if (!query || Object.getPrototypeOf(query) !== Object.prototype || query.kind !== "candidate_links" ||
          Object.keys(query).some(key => !keys.includes(key)) ||
          ["subject_name", "object_name", "predicate"].some(key => Object.hasOwn(query, key) && !bounded(query[key]))) fail("candidate_query_invalid");
      const offset = query.offset ?? 0, limit = query.limit ?? 100, includeStale = query.include_stale ?? false;
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > LIMITS.assertions ||
          !Number.isSafeInteger(limit) || limit < 1 || limit > 100 || typeof includeStale !== "boolean") fail("candidate_query_invalid");
      // view reauthorizes every retained source, even records excluded by these literal filters.
      // Names select witnesses only; they never resolve or connect entity identities.
      const matches = view().filter(record => !record.accepted && (includeStale || record.status === "candidate") &&
        (!Object.hasOwn(query, "subject_name") || record.candidate.subject === query.subject_name) &&
        (!Object.hasOwn(query, "object_name") || record.candidate.object === query.object_name) &&
        (!Object.hasOwn(query, "predicate") || record.candidate.predicate === query.predicate));
      return copy({ status: "unverified_candidates", epistemic_status: "candidate", semantic_verified: false,
        conclusion: null, query_scope: "this_artifact_only", matching: "exact_literal_names_not_entity_identity",
        items: matches.slice(offset, offset + limit).map(record => ({ ...record, epistemic_status: "candidate", semantic_verified: false,
          identity_verified: record.subject.status === "resolved" && record.object.status === "resolved" &&
            (!services.isCurrentIdentity || services.isCurrentIdentity(record.subject) === true && services.isCurrentIdentity(record.object) === true),
          polarity_is_proposal: true })),
        total: matches.length, next_offset: offset + limit < matches.length ? offset + limit : null });
    },
    explain({ subject_id, object_id, premise_ids = null, as_of_recorded, valid_at = null }) {
      if (!bounded(subject_id) || !bounded(object_id) || subject_id === object_id) fail("query_endpoints_invalid");
      const all = view({ as_of_recorded, valid_at }), byId = new Map(all.map(r => [r.record_id, r]));
      let path = null;
      if (premise_ids !== null) {
        if (!Array.isArray(premise_ids) || !premise_ids.length || premise_ids.length > LIMITS.query_depth || new Set(premise_ids).size !== premise_ids.length)
          fail("query_premises_invalid");
        path = premise_ids.map(key => byId.get(key));
        if (path.some(x => !x)) fail("query_premises_missing");
      } else {
        const edges = all.filter(r => r.status === "accepted" && r.polarity === "positive" && r.candidate.predicate === "depends_on");
        // Breadth-first bounded simple paths, lexical record order breaks ties reproducibly.
        const queue = [{ node: subject_id, path: [], visited: new Set([subject_id]) }];
        const seen = new Set([subject_id]);
        while (queue.length && !path) {
          const step = queue.shift();
          for (const edge of edges.filter(r => r.subject.entity_id === step.node)) {
            if (step.visited.has(edge.object.entity_id)) continue;
            const next = [...step.path, edge];
            if (edge.object.entity_id === object_id) { path = next; break; }
            if (next.length < LIMITS.query_depth && !seen.has(edge.object.entity_id)) {
              seen.add(edge.object.entity_id); queue.push({ node: edge.object.entity_id, path: next, visited: new Set([...step.visited, edge.object.entity_id]) });
            }
          }
        }
      }
      if (!path) return copy({ status: "unsupported", reason: "no_accepted_dependency_path", conclusion: null,
        evidence: all.filter(r => r.subject.entity_id === subject_id || r.object.entity_id === object_id) });
      if (path[0].subject.entity_id !== subject_id || path.at(-1).object.entity_id !== object_id ||
          path.some((r, i) => r.polarity !== "positive" || r.candidate.predicate !== "depends_on" || (i && path[i - 1].object.entity_id !== r.subject.entity_id))) fail("query_premises_not_path");
      const starts = path.map(r => r.valid_time.valid_from).filter(Boolean).sort(), ends = path.map(r => r.valid_time.valid_to).filter(Boolean).sort();
      const from = starts.at(-1) ?? null, to = ends[0] ?? null;
      const supported = path.every(r => r.status === "accepted") && !(from && to && from >= to);
      const dependencies = path.map(r => r.record_id);
      const conflictIds = new Set(path.flatMap(r => r.conflicting_record_ids));
      return copy({ status: supported ? "qualified" : "invalidated", rule_id: "documented-dependency-path", rule_version: "1",
        ...(path.some(r => r.epistemic_status === "source_attributed") ? { epistemic_status: "inferred", premise_epistemic_status: "source_attributed" } : {}),
        inference_id: id("inference", { subject_id, object_id, dependencies, rule_version: "1" }), premise_ids: dependencies,
        conclusion: supported ? "The retained evidence supports a documented dependency path. It does not establish settlement, performance, causation, or legal enforceability." : null,
        qualifications: [...new Set(["Source statements were verified against prepared text; original binary lineage remains catalog association only.",
          ...path.flatMap(r => r.uncertainty.qualifications)])].sort(),
        valid_time: { valid_from: from, valid_to: to }, evidence: path, conflicting_evidence: all.filter(r => conflictIds.has(r.record_id)) });
    },
  });
}
