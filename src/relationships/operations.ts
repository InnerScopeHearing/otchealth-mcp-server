import { canWriteRelationshipEvent, type RelationshipAuthority } from './authority.js';
import { FIXTURES, syntheticEvidence, type SyntheticAssertionFixture, type SyntheticFixtureId } from './synthetic-fixtures.js';
import { RELATIONSHIP_SCHEMA, canonicalJson, parseRelationshipEvent, sha256, utcMillis, type RelationshipEvent } from './schema.js';

function assertionSemantic(fixtureId: SyntheticFixtureId, fixture: SyntheticAssertionFixture) {
  return {
    subject: { entity_id: fixture.subject },
    predicate: fixture.predicate,
    object: { entity_id: fixture.object },
    assertion_class: fixture.assertionClass,
    evidence: syntheticEvidence(fixtureId),
    resolution: { subject: { status: 'resolved' as const }, object: { status: 'resolved' as const } },
    valid_time: { valid_from: fixture.validFrom, valid_to: fixture.validTo },
    auth: { ring: 'commons' as const, owner_agent: 'cto' as const, policy_version: 'relationship-pilot-v1' as const },
  };
}
export function relationshipIdForFixture(fixtureId: SyntheticFixtureId): string {
  const fixture = FIXTURES[fixtureId];
  if (fixture.operation !== 'assert') throw new Error(`${fixtureId} is not an assertion fixture`);
  return `rel_${sha256(canonicalJson(assertionSemantic(fixtureId, fixture)))}`;
}
export function buildFixtureEvent(
  fixtureId: SyntheticFixtureId,
  idempotencyKey: string,
  recordedAt: string,
  authority: RelationshipAuthority,
  existingEvents: readonly RelationshipEvent[],
): RelationshipEvent {
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(idempotencyKey)) throw new Error('invalid relationship idempotency key');
  utcMillis(recordedAt, 'recorded_at');
  const fixture = FIXTURES[fixtureId];
  const eventId = `rel_evt_${sha256(`pilot-v1\0${authority.lane}\0${idempotencyKey}`)}`;
  const intentSha = sha256(canonicalJson({ fixture_id: fixtureId, fixture, lane: authority.lane, policy_version: authority.policyVersion }));
  const common = {
    schema: RELATIONSHIP_SCHEMA,
    event_id: eventId,
    intent_sha256: intentSha,
    fixture_id: fixtureId,
    evidence: syntheticEvidence(fixtureId),
    transaction_time: { recorded_at: recordedAt },
    auth: { ring: 'commons' as const, owner_agent: 'cto' as const, policy_version: 'relationship-pilot-v1' as const },
  };
  let event: RelationshipEvent;
  if (fixture.operation === 'assert') {
    const supersedes = 'supersedesFixture' in fixture && fixture.supersedesFixture ? relationshipIdForFixture(fixture.supersedesFixture) : undefined;
    if (supersedes && !existingEvents.some((item) => item.operation === 'assert' && item.relationship_id === supersedes && canWriteRelationshipEvent(authority, item))) {
      throw new Error(`fixture prerequisite is missing or unauthorized for ${fixtureId}`);
    }
    const semantic = assertionSemantic(fixtureId, fixture);
    event = parseRelationshipEvent({
      ...common, operation: 'assert', ...semantic, relationship_id: relationshipIdForFixture(fixtureId),
      ...(supersedes ? { supersedes } : {}),
    });
  } else {
    const retracts = relationshipIdForFixture(fixture.retractsFixture);
    if (!existingEvents.some((item) => item.operation === 'assert' && item.relationship_id === retracts && canWriteRelationshipEvent(authority, item))) {
      throw new Error(`fixture prerequisite is missing or unauthorized: ${fixture.retractsFixture}`);
    }
    event = parseRelationshipEvent({ ...common, operation: 'retract', retracts, effective_valid_from: fixture.effectiveValidFrom });
  }
  return event;
}
