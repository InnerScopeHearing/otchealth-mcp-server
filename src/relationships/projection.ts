import { z } from 'zod';
import { assertRelationshipAuthority, canReadRelationshipEvent, type RelationshipAuthority } from './authority.js';
import {
  RELATIONSHIP_ENTITY_LIMIT, RELATIONSHIP_PREFIX, canonicalJson, eventObjectHash, parseRelationshipEvent, sha256,
  type RelationshipEvent,
} from './schema.js';
import { putCanonicalIfAbsent, readRelationshipEvents, relationshipPath, type RelationshipObjectStore } from './store.js';

const ProjectionSchema = z.object({
  schema: z.literal('otc.relationship.projection.pilot.v1'),
  generation_id: z.string().regex(/^gen_[a-f0-9]{64}$/),
  event_set_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  entity_id: z.string().regex(/^synthetic_[a-z0-9_]{1,80}$/),
  events: z.array(z.unknown()).max(100),
}).strict();
const ManifestSchema = z.object({
  schema: z.literal('otc.relationship.manifest.pilot.v1'),
  generation_id: z.string().regex(/^gen_[a-f0-9]{64}$/),
  event_set_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  event_count: z.number().int().nonnegative().max(100),
  entity_count: z.number().int().nonnegative().max(50),
  through_transaction_time: z.string(),
  projection_sha256_by_entity_hash: z.record(z.string().regex(/^[a-f0-9]{64}$/)),
  complete: z.literal(true),
}).strict();

export type RelationshipManifest = z.infer<typeof ManifestSchema>;
export interface RebuildOptions { failAfterProjectionWrites?: number; }

export function eventSetDigest(events: readonly RelationshipEvent[]): string {
  const rows = [...events].sort((a, b) => a.event_id.localeCompare(b.event_id))
    .map((event) => ({ event_id: event.event_id, object_sha256: eventObjectHash(event) }));
  return sha256(canonicalJson(rows));
}
export function generationId(events: readonly RelationshipEvent[]): string { return `gen_${eventSetDigest(events)}`; }
function entityHash(entityId: string): string { return sha256(entityId); }
function projectionPath(generation: string, entityId: string): string {
  return `${RELATIONSHIP_PREFIX}projections/${generation}/entity/${entityHash(entityId)}.json`;
}
function manifestPath(generation: string): string { return `${RELATIONSHIP_PREFIX}manifests/${generation}.json`; }

export async function rebuildRelationshipProjection(
  store: RelationshipObjectStore,
  authority: RelationshipAuthority,
  options: RebuildOptions = {},
): Promise<{ generation_id: string; event_set_sha256: string; event_count: number; entity_count: number; replayed: boolean }> {
  assertRelationshipAuthority(authority);
  const events = await readRelationshipEvents(store, authority);
  const eventSetSha = eventSetDigest(events);
  const generation = `gen_${eventSetSha}`;
  const assertions = new Map(events.filter((e) => e.operation === 'assert').map((e) => [e.relationship_id, e]));
  const entitiesByEvent = new Map<string, Set<string>>();
  for (const event of events) {
    if (!canReadRelationshipEvent(authority, event)) continue;
    const entities = new Set<string>();
    if (event.operation === 'assert') {
      entities.add(event.subject.entity_id);
      entities.add(event.object.entity_id);
      if (event.supersedes) {
        const target = assertions.get(event.supersedes);
        if (target) { entities.add(target.subject.entity_id); entities.add(target.object.entity_id); }
      }
    } else {
      const target = assertions.get(event.retracts);
      if (!target) throw new Error(`retraction target is missing: ${event.retracts}`);
      entities.add(target.subject.entity_id);
      entities.add(target.object.entity_id);
    }
    entitiesByEvent.set(event.event_id, entities);
  }
  const entityIds = [...new Set([...entitiesByEvent.values()].flatMap((set) => [...set]))].sort();
  if (entityIds.length > RELATIONSHIP_ENTITY_LIMIT) throw new Error(`relationship pilot entity cap exceeded: ${entityIds.length}`);
  const projectionHashes: Record<string, string> = {};
  let writes = 0;
  let anyCreated = false;
  for (const entityId of entityIds) {
    const adjacent = events.filter((event) => entitiesByEvent.get(event.event_id)?.has(entityId));
    const doc = {
      schema: 'otc.relationship.projection.pilot.v1' as const,
      generation_id: generation,
      event_set_sha256: eventSetSha,
      entity_id: entityId,
      events: adjacent,
    };
    ProjectionSchema.parse(doc);
    const path = projectionPath(generation, entityId);
    const result = await putCanonicalIfAbsent(store, path, doc);
    projectionHashes[entityHash(entityId)] = result.sha256;
    anyCreated ||= result.created;
    writes += 1;
    if (options.failAfterProjectionWrites === writes) throw new Error('injected projection crash before manifest');
  }
  const through = events.map((event) => event.transaction_time.recorded_at).sort().at(-1) ?? '1970-01-01T00:00:00Z';
  const manifest = {
    schema: 'otc.relationship.manifest.pilot.v1' as const,
    generation_id: generation,
    event_set_sha256: eventSetSha,
    event_count: events.length,
    entity_count: entityIds.length,
    through_transaction_time: through,
    projection_sha256_by_entity_hash: projectionHashes,
    complete: true as const,
  };
  ManifestSchema.parse(manifest);
  const manifestResult = await putCanonicalIfAbsent(store, manifestPath(generation), manifest);
  return { generation_id: generation, event_set_sha256: eventSetSha, event_count: events.length, entity_count: entityIds.length, replayed: !anyCreated && manifestResult.replayed };
}

export interface OpenRelationshipProjection {
  generation_id: string;
  event_set_sha256: string;
  manifest: RelationshipManifest;
}

export async function openCurrentProjection(
  store: RelationshipObjectStore,
  authority: RelationshipAuthority,
): Promise<OpenRelationshipProjection> {
  assertRelationshipAuthority(authority);
  const events = await readRelationshipEvents(store, authority);
  const digest = eventSetDigest(events);
  const generation = `gen_${digest}`;
  const rawManifest = await store.get(relationshipPath(manifestPath(generation)));
  if (rawManifest === null) throw new Error('relationship projection is stale or unavailable; rebuild required');
  let parsedManifest: unknown;
  try { parsedManifest = JSON.parse(rawManifest); } catch { throw new Error('relationship projection manifest is invalid JSON'); }
  const manifest = ManifestSchema.parse(parsedManifest);
  if (manifest.event_set_sha256 !== digest || manifest.generation_id !== generation || manifest.event_count !== events.length) {
    throw new Error('relationship projection manifest does not match the current event set');
  }
  return { generation_id: generation, event_set_sha256: digest, manifest };
}

export async function loadProjectionEntity(
  store: RelationshipObjectStore,
  authority: RelationshipAuthority,
  opened: OpenRelationshipProjection,
  entityId: string,
): Promise<RelationshipEvent[]> {
  assertRelationshipAuthority(authority);
  const hash = entityHash(entityId);
  const expectedHash = opened.manifest.projection_sha256_by_entity_hash[hash];
  if (!expectedHash) return [];
  const rawProjection = await store.get(relationshipPath(projectionPath(opened.generation_id, entityId)));
  if (rawProjection === null) throw new Error('relationship projection object is missing');
  let parsedProjection: unknown;
  try { parsedProjection = JSON.parse(rawProjection); } catch { throw new Error('relationship projection object is invalid JSON'); }
  const projection = ProjectionSchema.parse(parsedProjection);
  if (projection.entity_id !== entityId || projection.generation_id !== opened.generation_id || projection.event_set_sha256 !== opened.event_set_sha256) {
    throw new Error('relationship projection object does not match the open generation');
  }
  if (sha256(canonicalJson(projection)) !== expectedHash) throw new Error('relationship projection object failed integrity verification');
  return projection.events.map(parseRelationshipEvent).filter((event) => canReadRelationshipEvent(authority, event));
}

export async function loadCurrentProjection(
  store: RelationshipObjectStore,
  authority: RelationshipAuthority,
  entityId: string,
): Promise<{ generation_id: string; events: RelationshipEvent[] }> {
  const opened = await openCurrentProjection(store, authority);
  return { generation_id: opened.generation_id, events: await loadProjectionEntity(store, authority, opened, entityId) };
}
