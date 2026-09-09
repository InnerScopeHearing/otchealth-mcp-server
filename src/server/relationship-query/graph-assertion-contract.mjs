import { createHash } from "node:crypto";

export const CONTRACT_VERSION = "graph-assertion-v2";
export const ROOM_POLICY = Object.freeze({
  finance: Object.freeze({ source_index: "finance-cfo-source-docs", policy_ref: "gateway:isLaneAllowed" }),
  legal_company: Object.freeze({ source_index: "legal-company", policy_ref: "gateway:isLaneAllowed" }),
});
const INTERNAL = new Set(["_text", "_catalog", "_review", "_memory", "_state", "_archive"]);
const MENTION_FIELDS = Object.freeze({ entity: "entity", entities: "entity", named_entities_orgs: "organization", named_entities_people: "person", signatories: "person", counterparty: "organization_or_person" });
const TYPED_PREDICATES = new Set(["party_to", "signatory_of", "owns", "controls", "obligated_to", "amends", "supersedes", "depends_on"]);
const ASSERTION_CLASSES = new Set(["fact", "candidate", "inference"]);
const VALID_BASES = new Set(["catalog_doc_date", "exact_witness", "correction", "reviewed_rule", "unknown"]);

export class ContractError extends Error { constructor(code) { super(code); this.code = code; } }
const fail = (code) => { throw new ContractError(code); };
export const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const hashOk = (value) => typeof value === "string" && /^[a-f0-9]{64}$/i.test(value) && !/^0{64}$/.test(value);
const textOk = (value) => typeof value === "string" && value.trim().length > 0;
const utcOk = (value) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(new Date(value).getTime()) && new Date(value).toISOString() === value;
const canonical = (value) => value === null || typeof value !== "object" ? JSON.stringify(value) : Array.isArray(value) ? `[${value.map(canonical).join(",")}]` : `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
const idFor = (kind, intent) => `${kind}_${sha256(`${CONTRACT_VERSION}\0${canonical(intent)}`)}`;
const normalizeName = (value) => value.normalize("NFKC").trim().toLocaleLowerCase("en-US").replace(/\s+/g, " ");

export function normalizeSourcePath(value) {
  if (!textOk(value) || value.includes("\0")) fail("invalid_source_path");
  let path = value.replace(/\\/g, "/");
  if (/^(?:\/|[a-zA-Z]:|[a-zA-Z][a-zA-Z0-9+.-]*:)/.test(path)) fail("invalid_source_path");
  const parts = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") fail("invalid_source_path");
    parts.push(part);
  }
  if (!parts.length) fail("invalid_source_path");
  if (INTERNAL.has(parts[0].toLowerCase())) fail("internal_source_path");
  return parts.join("/");
}

export function authorityForRoom(room) {
  const policy = ROOM_POLICY[room];
  if (!policy) fail("room_not_allowlisted");
  return Object.freeze({ source_room: room, source_index: policy.source_index, policy_ref: policy.policy_ref });
}
export function eligibility(row, room) {
  authorityForRoom(room);
  if (!row || typeof row !== "object" || Array.isArray(row)) return { eligible: false, reason: "row_shape" };
  try { normalizeSourcePath(row.path); } catch { return { eligible: false, reason: "path" }; }
  if (!hashOk(row.sha256)) return { eligible: false, reason: "source_hash" };
  if (row.sidecar !== true) return { eligible: false, reason: "sidecar" };
  if (row.err) return { eligible: false, reason: "row_error" };
  if (row.enriched !== true || row.enriched_sha256 !== row.sha256) return { eligible: false, reason: "stale_enrichment" };
  return { eligible: true, reason: "current_enrichment" };
}

function documentIdentity(doc) { return { authority: doc.authority, source_path_hash: doc.source_path_hash, source_version: doc.source_version }; }
function validateDocument(doc) {
  if (!doc || doc.type !== "document_version" || !hashOk(doc.source_path_hash) || !hashOk(doc.source_version)) fail("document_version_invalid");
  const authority = authorityForRoom(doc.authority?.source_room);
  if (canonical(authority) !== canonical(doc.authority)) fail("document_authority_invalid");
  if (doc.document_version_id !== idFor("docv", documentIdentity(doc))) fail("document_version_id_invalid");
  if (doc.eligibility_proof?.kind !== "current_catalog_enrichment" || doc.eligibility_proof.source_version !== doc.source_version) fail("document_eligibility_unbound");
  return doc;
}
export function documentVersion(row, room) {
  const check = eligibility(row, room);
  if (!check.eligible) fail(`ineligible_${check.reason}`);
  const authority = authorityForRoom(room);
  const source_path_hash = sha256(normalizeSourcePath(row.path));
  const source_version = row.sha256.toLowerCase();
  const base = { type: "document_version", source_path_hash, source_version, authority, eligibility_proof: Object.freeze({ kind: "current_catalog_enrichment", source_version }) };
  return Object.freeze({ ...base, document_version_id: idFor("docv", documentIdentity(base)) });
}

export function validTime(input) {
  if (input !== undefined && input !== null && (typeof input !== "object" || Array.isArray(input))) fail("invalid_valid_time");
  const value = input || {};
  const from = value.valid_from ?? null, to = value.valid_to ?? null;
  if (from !== null && !utcOk(from)) fail("invalid_valid_time");
  if (to !== null && !utcOk(to)) fail("invalid_valid_time");
  if (from !== null && to !== null && new Date(to).getTime() <= new Date(from).getTime()) fail("invalid_valid_time");
  const fromBasis = from === null ? "unknown" : value.valid_from_basis;
  const toBasis = to === null ? "unknown" : value.valid_to_basis;
  if (!VALID_BASES.has(fromBasis) || !VALID_BASES.has(toBasis)) fail("invalid_valid_time_basis");
  return Object.freeze({ valid_from: from, valid_to: to, valid_from_basis: fromBasis, valid_to_basis: toBasis });
}
function mentionValues(row, field) {
  const value = row[field];
  if (value === undefined || value === null || value === "") return [];
  if (field === "entity" || field === "counterparty") { if (!textOk(value)) fail("invalid_mention_value"); return [value.trim()]; }
  if (!Array.isArray(value) || value.some((item) => !textOk(item))) fail("invalid_mention_value");
  return value.map((item) => item.trim());
}
function basePermission(authority) { return Object.freeze({ policy_ref: authority.policy_ref, source_room: authority.source_room, source_index: authority.source_index, reauthorize_on_read: true }); }

export function projectMentionAssertions(row, room, recordedAt) {
  if (!utcOk(recordedAt)) fail("invalid_recorded_time");
  const doc = documentVersion(row, room);
  const validity = row.doc_date ? validTime({ valid_from: row.doc_date, valid_to: null, valid_from_basis: "catalog_doc_date", valid_to_basis: "unknown" }) : validTime();
  const assertions = [];
  for (const [field, entityType] of Object.entries(MENTION_FIELDS)) mentionValues(row, field).forEach((displayName, itemIndex) => {
    const candidateIntent = { authority: doc.authority, document_version_id: doc.document_version_id, field, item_index: itemIndex, entity_type: entityType, normalized_name: normalizeName(displayName) };
    const entity_candidate_id = idFor("candidate", candidateIntent);
    const witness = Object.freeze({ authority: doc.authority, document_version_id: doc.document_version_id, source_path_hash: doc.source_path_hash, source_version: doc.source_version, evidence_kind: "metadata_field", field, item_index: itemIndex });
    const semantic_intent = Object.freeze({
      authority: doc.authority,
      permission: basePermission(doc.authority),
      subject_id: doc.document_version_id,
      predicate: field === "signatories" ? "document_lists_signatory" : field === "counterparty" ? "document_names_counterparty" : "document_mentions_entity",
      object_id: entity_candidate_id,
      assertion_class: "candidate",
      support: Object.freeze({ kind: "unverified_metadata_candidate" }),
      witness,
      valid_time: validity,
    });
    assertions.push(Object.freeze({ type: "assertion", event_id: idFor("assertion", semantic_intent), semantic_intent, recorded_at: recordedAt, entity_candidate: Object.freeze({ entity_candidate_id, entity_type: entityType, resolution_status: "unresolved", display_name: displayName, normalized_name_hash: sha256(normalizeName(displayName)) }) }));
  });
  return Object.freeze({ document: doc, assertions: Object.freeze(assertions) });
}

function validateEventIdentity(event) {
  if (!event || !["assertion", "retraction"].includes(event.type) || !event.semantic_intent || !utcOk(event.recorded_at)) fail("replay_event_shape");
  if (event.event_id !== idFor(event.type, event.semantic_intent)) fail("replay_event_id_invalid");
  return event;
}
export function acceptReplay(existing, incoming) {
  validateEventIdentity(existing); validateEventIdentity(incoming);
  if (existing.type !== incoming.type || existing.event_id !== incoming.event_id) fail("replay_identity_mismatch");
  if (canonical(existing.semantic_intent) !== canonical(incoming.semantic_intent)) fail("replay_intent_conflict");
  return existing;
}

function eventWitness(event) {
  const witness = event?.semantic_intent?.witness;
  if (!witness || !hashOk(witness.source_path_hash) || !hashOk(witness.source_version)) fail("correction_witness_invalid");
  return witness;
}
export function correctionEvent(oldAssertion, newDocument, trustedClock) {
  validateEventIdentity(oldAssertion); validateDocument(newDocument);
  if (oldAssertion.type !== "assertion") fail("invalid_correction_target");
  if (!trustedClock || typeof trustedClock.recordedAt !== "function") fail("correction_clock_required");
  const recordedAt = trustedClock.recordedAt();
  if (!utcOk(recordedAt)) fail("invalid_recorded_time");
  if (new Date(recordedAt).getTime() <= new Date(oldAssertion.recorded_at).getTime()) fail("correction_clock_order");
  const witness = eventWitness(oldAssertion);
  if (canonical(oldAssertion.semantic_intent.authority) !== canonical(newDocument.authority)) fail("correction_authority_conflict");
  if (witness.source_path_hash !== newDocument.source_path_hash) fail("correction_path_conflict");
  if (witness.source_version === newDocument.source_version) fail("correction_requires_new_source_version");
  const semantic_intent = Object.freeze({ authority: newDocument.authority, permission: oldAssertion.semantic_intent.permission, predicate: "retracts", target_event_id: oldAssertion.event_id, target_witness_hash: sha256(canonical(witness)), replacement_document_version_id: newDocument.document_version_id, replacement_source_version: newDocument.source_version });
  return Object.freeze({ type: "retraction", event_id: idFor("retraction", semantic_intent), semantic_intent, recorded_at: recordedAt });
}
export function assertionsAtRecordedTime(events, asOfRecorded) {
  if (!utcOk(asOfRecorded)) fail("invalid_recorded_time");
  events.forEach(validateEventIdentity);
  const cutoff = new Date(asOfRecorded).getTime();
  const candidates = events.filter((e) => e.type === "assertion" && new Date(e.recorded_at).getTime() <= cutoff);
  const inactive = new Set(events.filter((e) => e.type === "retraction" && new Date(e.recorded_at).getTime() <= cutoff).map((e) => e.semantic_intent.target_event_id));
  let changed = true;
  while (changed) {
    changed = false;
    for (const event of candidates) {
      if (inactive.has(event.event_id)) continue;
      const premises = event.semantic_intent.support?.premise_event_ids || [];
      if (premises.some((id) => inactive.has(id) || !candidates.some((candidate) => candidate.event_id === id))) { inactive.add(event.event_id); changed = true; }
    }
  }
  return candidates.filter((event) => !inactive.has(event.event_id));
}
function trustedServices(services) {
  if (!services || !textOk(services.callerLane) || typeof services.lookupDocumentVersion !== "function" || typeof services.authorizeDocument !== "function" || typeof services.resolveEndpoint !== "function" || typeof services.recordedAt !== "function") fail("caller_authority_required");
  return services;
}
function permissionFromDecision(decision, callerLane) {
  if (!decision || decision.allowed !== true || !decision.provenance || decision.provenance.decision_source !== "authenticated_gateway" || !textOk(decision.provenance.policy_version) || !Array.isArray(decision.provenance.allowed_roles) || !decision.provenance.allowed_roles.includes(callerLane)) fail("caller_room_denied");
  return Object.freeze({ decision_source: "authenticated_gateway", policy_version: decision.provenance.policy_version, allowed_roles: Object.freeze([...new Set(decision.provenance.allowed_roles)].sort()), reauthorize_on_read: true });
}
function resolvedEndpoint(services, id, authority) {
  if (!textOk(id)) fail("endpoint_not_resolved");
  const result = services.resolveEndpoint(id, authority);
  if (!result || result.status !== "resolved" || result.entity_id !== id || !textOk(result.registry_version)) fail("endpoint_not_resolved");
  return Object.freeze({ entity_id: result.entity_id, registry_version: result.registry_version, identity_event_id: result.identity_event_id || null });
}
function spanWitness(input, bytes, doc) {
  const start = input.span_start_byte, end = input.span_end_byte;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || end > bytes.length) fail("typed_span_bounds");
  return Object.freeze({ authority: doc.authority, document_version_id: doc.document_version_id, source_path_hash: doc.source_path_hash, source_version: doc.source_version, evidence_kind: "exact_byte_span", span_start_byte: start, span_end_byte: end, span_sha256: sha256(bytes.subarray(start, end)) });
}
function premiseValidTime(premises) {
  const times = premises.map((event) => event.semantic_intent.valid_time);
  if (times.some((time) => !time || typeof time !== "object")) fail("inference_support_required");
  const starts = times.map((time) => time.valid_from).filter(Boolean).sort();
  const ends = times.map((time) => time.valid_to).filter(Boolean).sort();
  const from = starts.length ? starts.at(-1) : null;
  const to = ends.length ? ends[0] : null;
  if (from && to && new Date(to).getTime() <= new Date(from).getTime()) fail("inference_support_required");
  return validTime({ valid_from: from, valid_to: to, valid_from_basis: from ? "reviewed_rule" : "unknown", valid_to_basis: to ? "reviewed_rule" : "unknown" });
}
function supportFor(input, services, claim, witness, permission, recordedAt, sourceBytes, requestedValidity) {
  if (input.assertion_class === "candidate") {
    if (input.valid_time !== undefined && input.valid_time !== null) fail("valid_time_support_required");
    return { support: Object.freeze({ kind: "unverified_candidate" }), permission, valid_time: validTime() };
  }
  if (input.assertion_class === "fact") {
    for (const basis of [requestedValidity.valid_from_basis, requestedValidity.valid_to_basis]) if (!["unknown", "exact_witness"].includes(basis)) fail("valid_time_support_required");
    if (typeof services.verifyFact !== "function") fail("semantic_support_required");
    const spanCopy = Buffer.from(sourceBytes.subarray(witness.span_start_byte, witness.span_end_byte));
    const verification = services.verifyFact({ claim: Object.freeze({ ...claim, valid_time: requestedValidity }), witness, permission, source_span_bytes: spanCopy });
    if (!verification || verification.verified !== true || !textOk(verification.verifier_id) || !textOk(verification.verifier_version) || !textOk(verification.verification_basis)) fail("semantic_support_required");
    return { support: Object.freeze({ kind: "verified_fact", verifier_id: verification.verifier_id, verifier_version: verification.verifier_version, verification_basis: verification.verification_basis }), permission, valid_time: requestedValidity };
  }
  if (input.valid_time !== undefined && input.valid_time !== null) fail("inference_support_required");
  if (!Array.isArray(input.premise_event_ids) || input.premise_event_ids.length === 0 || !textOk(input.rule_id) || !textOk(input.rule_version) || typeof services.lookupPremise !== "function" || typeof services.lookupRule !== "function") fail("inference_support_required");
  const premiseIds = [...new Set(input.premise_event_ids)].sort();
  const premises = premiseIds.map((id) => { const event = services.lookupPremise(id); validateEventIdentity(event); if (event.event_id !== id || event.type !== "assertion" || event.semantic_intent.assertion_class === "candidate" || new Date(event.recorded_at).getTime() > new Date(recordedAt).getTime()) fail("inference_support_required"); return event; });
  const derivedValidity = premiseValidTime(premises);
  const rule = services.lookupRule(input.rule_id, input.rule_version);
  const derivation = rule && typeof rule.derive === "function" ? rule.derive({ premises, claim: Object.freeze({ ...claim, valid_time: derivedValidity }) }) : null;
  if (!rule || rule.reviewed !== true || rule.rule_id !== input.rule_id || rule.rule_version !== input.rule_version || derivation !== true) fail("inference_support_required");
  if (typeof services.authorizePremise !== "function") fail("caller_room_denied");
  const premisePermissions = premises.map((event) => permissionFromDecision(services.authorizePremise(services.callerLane, event), services.callerLane));
  const roleSets = [permission, ...premisePermissions].map((item) => new Set(item.allowed_roles));
  const intersection = [...roleSets[0]].filter((role) => roleSets.every((set) => set.has(role))).sort();
  if (!intersection.includes(services.callerLane) || intersection.length === 0) fail("caller_room_denied");
  const effectivePermission = Object.freeze({ decision_source: "authenticated_gateway", policy_version: `intersection_${sha256(canonical([permission.policy_version, ...premisePermissions.map((item) => item.policy_version)]))}`, allowed_roles: Object.freeze(intersection), inherited_from_event_ids: Object.freeze(premiseIds), reauthorize_on_read: true });
  return { support: Object.freeze({ kind: "reviewed_rule", premise_event_ids: Object.freeze(premiseIds), rule_id: rule.rule_id, rule_version: rule.rule_version }), permission: effectivePermission, valid_time: derivedValidity };
}
export function createTypedSemanticAssertion(input, sourceBytes, serviceDeps) {
  if (!input || typeof input !== "object" || Array.isArray(input)) fail("typed_input_shape");
  const services = trustedServices(serviceDeps);
  if (["source_room", "source_path_hash", "source_version", "authority"].some((key) => Object.hasOwn(input, key))) fail("authority_override_refused");
  if (Object.hasOwn(input, "recorded_at")) fail("recorded_time_override_refused");
  if (!textOk(input.document_version_id)) fail("document_eligibility_unbound");
  const doc = validateDocument(services.lookupDocumentVersion(input.document_version_id));
  if (doc.document_version_id !== input.document_version_id) fail("document_eligibility_unbound");
  const permission = permissionFromDecision(services.authorizeDocument(services.callerLane, doc), services.callerLane);
  if (!Buffer.isBuffer(sourceBytes) || sha256(sourceBytes) !== doc.source_version) fail("typed_source_version_mismatch");
  if (!TYPED_PREDICATES.has(input.predicate)) fail("typed_predicate");
  if (!ASSERTION_CLASSES.has(input.assertion_class)) fail("typed_assertion_class");
  const subject = resolvedEndpoint(services, input.subject_id, doc.authority);
  const object = resolvedEndpoint(services, input.object_id, doc.authority);
  const recordedAt = services.recordedAt();
  if (!utcOk(recordedAt)) fail("invalid_recorded_time");
  const witness = spanWitness(input, sourceBytes, doc);
  const validity = validTime(input.valid_time);
  const claim = Object.freeze({ subject_id: subject.entity_id, predicate: input.predicate, object_id: object.entity_id, assertion_class: input.assertion_class });
  const supported = supportFor(input, services, claim, witness, permission, recordedAt, sourceBytes, validity);
  const semantic_intent = Object.freeze({ authority: doc.authority, permission: supported.permission, subject, predicate: input.predicate, object, assertion_class: input.assertion_class, support: supported.support, witness, valid_time: supported.valid_time });
  return Object.freeze({ type: "assertion", event_id: idFor("assertion", semantic_intent), semantic_intent, recorded_at: recordedAt });
}