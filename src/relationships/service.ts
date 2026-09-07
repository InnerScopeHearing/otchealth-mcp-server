import type { ToolContext } from '../tools/registry.js';
import { requireRelationshipPilotAuthority } from './authority.js';
import { RELATIONSHIP_EVENT_LIMIT } from './schema.js';
import { FIXTURES, type SyntheticFixtureId } from './synthetic-fixtures.js';
import { buildFixtureEvent } from './operations.js';
import { rebuildRelationshipProjection } from './projection.js';
import { queryRelationships, type RelationshipQueryInput } from './query.js';
import { readRelationshipEvents, RelationshipWriteOutcomeUnknownError, S3RelationshipObjectStore, writeRelationshipEvent, type RelationshipObjectStore } from './store.js';

export interface RelationshipServiceDeps {
  store: RelationshipObjectStore;
  now: () => Date;
}
function defaults(): RelationshipServiceDeps { return { store: new S3RelationshipObjectStore(), now: () => new Date() }; }

export async function ingestSyntheticFixture(
  input: { fixtureId: SyntheticFixtureId; idempotencyKey: string },
  ctx: Pick<ToolContext, 'callerAgent' | 'dryRun'>,
  deps: RelationshipServiceDeps = defaults(),
) {
  const authority = requireRelationshipPilotAuthority(ctx);
  if (!(input.fixtureId in FIXTURES)) throw new Error('unknown synthetic relationship fixture');
  const existing = await readRelationshipEvents(deps.store, authority);
  const event = buildFixtureEvent(input.fixtureId, input.idempotencyKey, deps.now().toISOString(), authority, existing);
  if (ctx.dryRun) return { persisted: false, projected: false, dry_run: true, event_id: event.event_id, relationship_id: event.operation === 'assert' ? event.relationship_id : undefined };
  if (existing.length >= RELATIONSHIP_EVENT_LIMIT && !existing.some((item) => item.event_id === event.event_id)) {
    throw new Error('relationship pilot event cap reached; refusing a new operation');
  }
  let write;
  try {
    write = await writeRelationshipEvent(deps.store, authority, event);
  } catch (error) {
    if (!(error instanceof RelationshipWriteOutcomeUnknownError)) throw error;
    return {
      persisted: null, projected: false, durability: 'UNKNOWN' as const, event_id: event.event_id,
      retry: 'Retry the same fixture and idempotency key to reconcile the original operation.',
    };
  }
  try {
    const projection = await rebuildRelationshipProjection(deps.store, authority);
    return { persisted: true, projected: true, replayed: write.replayed, event_id: write.event.event_id, relationship_id: write.event.operation === 'assert' ? write.event.relationship_id : undefined, recorded_at: write.event.transaction_time.recorded_at, projection };
  } catch (error) {
    return { persisted: true, projected: false, replayed: write.replayed, event_id: write.event.event_id, relationship_id: write.event.operation === 'assert' ? write.event.relationship_id : undefined, recorded_at: write.event.transaction_time.recorded_at, projection_error: error instanceof Error ? error.message : String(error) };
  }
}
export async function rebuildSyntheticRelationships(ctx: Pick<ToolContext, 'callerAgent' | 'dryRun'>, deps: RelationshipServiceDeps = defaults()) {
  const authority = requireRelationshipPilotAuthority(ctx);
  if (ctx.dryRun) {
    const events = await readRelationshipEvents(deps.store, authority);
    return { rebuilt: false, dry_run: true, event_count: events.length };
  }
  return { rebuilt: true, ...(await rebuildRelationshipProjection(deps.store, authority)) };
}
export async function querySyntheticRelationships(input: RelationshipQueryInput, ctx: Pick<ToolContext, 'callerAgent'>, deps: RelationshipServiceDeps = defaults()) {
  const authority = requireRelationshipPilotAuthority(ctx);
  return await queryRelationships(deps.store, authority, input);
}
