import type { RelationshipAuthority } from './authority.js';
import { materializeRelationships } from './materialize.js';
import { loadProjectionEntity, openCurrentProjection } from './projection.js';
import { RELATIONSHIP_EDGE_LIMIT, RELATIONSHIP_ENTITY_LIMIT, PredicateSchema, utcMillis, type RelationshipEvent, type RelationshipPredicate } from './schema.js';
import type { RelationshipObjectStore } from './store.js';

export interface RelationshipQueryInput {
  entityId: string;
  hops: 1 | 2;
  predicates?: RelationshipPredicate[];
  asOfValid: string;
  asOfTransaction: string;
  includeCandidates?: boolean;
}
export async function queryRelationships(store: RelationshipObjectStore, authority: RelationshipAuthority, input: RelationshipQueryInput) {
  if (!/^synthetic_[a-z0-9_]{1,80}$/.test(input.entityId)) throw new Error('relationship pilot accepts synthetic entity ids only');
  utcMillis(input.asOfValid, 'as_of_valid');
  utcMillis(input.asOfTransaction, 'as_of_transaction');
  const predicates = new Set((input.predicates ?? []).map((value) => PredicateSchema.parse(value)));
  const opened = await openCurrentProjection(store, authority);
  const collected = new Map<string, RelationshipEvent>();
  const visited = new Set([input.entityId]);
  let frontier = [input.entityId];

  for (let depth = 1; depth <= input.hops && frontier.length > 0; depth += 1) {
    for (const entity of frontier) {
      const projectionEvents = await loadProjectionEntity(store, authority, opened, entity);
      for (const event of projectionEvents) collected.set(event.event_id, event);
    }
    const active = materializeRelationships([...collected.values()], authority, {
      asOfValid: input.asOfValid, asOfTransaction: input.asOfTransaction, includeCandidates: input.includeCandidates,
    }).filter((edge) => predicates.size === 0 || predicates.has(edge.predicate));
    const next = new Set<string>();
    for (const node of frontier) {
      for (const edge of active) {
        const from = edge.subject.entity_id, to = edge.object.entity_id;
        if (from !== node && to !== node) continue;
        const other = from === node ? to : from;
        if (!visited.has(other)) next.add(other);
      }
    }
    for (const entity of next) visited.add(entity);
    if (visited.size > RELATIONSHIP_ENTITY_LIMIT) throw new Error('relationship pilot entity result cap exceeded');
    frontier = [...next].sort();
  }

  const active = materializeRelationships([...collected.values()], authority, {
    asOfValid: input.asOfValid, asOfTransaction: input.asOfTransaction, includeCandidates: input.includeCandidates,
  }).filter((edge) => predicates.size === 0 || predicates.has(edge.predicate));
  const depths = new Map<string, number>([[input.entityId, 0]]);
  const edgeDepths = new Map<string, number>();
  frontier = [input.entityId];
  for (let depth = 1; depth <= input.hops && frontier.length > 0; depth += 1) {
    const next = new Set<string>();
    for (const node of frontier) {
      for (const edge of active) {
        const from = edge.subject.entity_id, to = edge.object.entity_id;
        if (from !== node && to !== node) continue;
        edgeDepths.set(edge.relationship_id, Math.min(depth, edgeDepths.get(edge.relationship_id) ?? depth));
        const other = from === node ? to : from;
        if (!depths.has(other)) { depths.set(other, depth); next.add(other); }
      }
    }
    frontier = [...next];
  }
  if (edgeDepths.size > RELATIONSHIP_EDGE_LIMIT) throw new Error('relationship pilot edge result cap exceeded');
  const edges = active.filter((edge) => edgeDepths.has(edge.relationship_id)).map((edge) => ({
    relationship_id: edge.relationship_id,
    subject: edge.subject.entity_id,
    predicate: edge.predicate,
    object: edge.object.entity_id,
    assertion_class: edge.assertion_class,
    valid_time: edge.valid_time,
    recorded_at: edge.transaction_time.recorded_at,
    depth: edgeDepths.get(edge.relationship_id),
    evidence: edge.evidence.map((item) => ({
      source_uri: item.source_uri, source_sha256: item.source_sha256, excerpt_sha256: item.excerpt_sha256, locator: item.locator,
    })),
  })).sort((a, b) => a.depth! - b.depth! || a.relationship_id.localeCompare(b.relationship_id));
  return {
    generation_id: opened.generation_id,
    event_set_sha256: opened.event_set_sha256,
    as_of_valid: input.asOfValid,
    as_of_transaction: input.asOfTransaction,
    nodes: [...depths.entries()].map(([entity_id, depth]) => ({ entity_id, depth })).sort((a, b) => a.depth - b.depth || a.entity_id.localeCompare(b.entity_id)),
    edges,
  };
}
