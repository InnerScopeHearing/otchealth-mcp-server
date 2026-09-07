import { getTextFromS3, listBlobsFromS3, putObjectToS3, S3ObjectAlreadyExistsError, S3WriteHttpError, S3WriteTransportError } from '../legal/s3-blob-store.js';
import { assertRelationshipAuthority, canReadRelationshipEvent, canWriteRelationshipEvent, type RelationshipAuthority } from './authority.js';
import { RELATIONSHIP_EVENT_LIMIT, RELATIONSHIP_EVENT_SCAN_LIMIT, RELATIONSHIP_PREFIX, canonicalJson, parseRelationshipEvent, sha256, type RelationshipEvent } from './schema.js';

const ACCOUNT = 'otchealthcommons';
const CONTAINER = 'company-journal';
export const EVENT_PREFIX = `${RELATIONSHIP_PREFIX}events/`;

export class RelationshipWriteOutcomeUnknownError extends Error {
  constructor() {
    super('Relationship event write outcome is UNKNOWN. Retry the same fixture with the same idempotency key to reconcile; do not generate a new key.');
    this.name = 'RelationshipWriteOutcomeUnknownError';
  }
}

export interface RelationshipObjectStore {
  list(prefix: string): Promise<Array<{ name: string }>>;
  get(path: string): Promise<string | null>;
  putIfAbsent(path: string, body: string): Promise<void>;
}

export class S3RelationshipObjectStore implements RelationshipObjectStore {
  async list(prefix: string): Promise<Array<{ name: string }>> { return await listBlobsFromS3(ACCOUNT, CONTAINER, prefix); }
  async get(path: string): Promise<string | null> { return await getTextFromS3(ACCOUNT, CONTAINER, path); }
  async putIfAbsent(path: string, body: string): Promise<void> {
    await putObjectToS3(ACCOUNT, CONTAINER, path, Buffer.from(body, 'utf8'), 'application/json', false);
  }
}

export function relationshipPath(path: string): string {
  if (!path.startsWith(RELATIONSHIP_PREFIX) || path.includes('..') || path.includes('\\')) {
    throw new Error('relationship object path escaped the fixed pilot prefix');
  }
  return path;
}

export async function putCanonicalIfAbsent(store: RelationshipObjectStore, path: string, value: unknown) {
  relationshipPath(path);
  const body = canonicalJson(value);
  try {
    await store.putIfAbsent(path, body);
    return { created: true, replayed: false, sha256: sha256(body) };
  } catch (error) {
    if (!(error instanceof S3ObjectAlreadyExistsError)) throw error;
    const existing = await store.get(path);
    if (existing === null) throw new Error(`conditional create conflict but strict read found no object at ${path}`);
    if (existing !== body) throw new Error(`immutable relationship object collision at ${path}`);
    return { created: false, replayed: true, sha256: sha256(body) };
  }
}

export async function readRelationshipEvents(store: RelationshipObjectStore, authority: RelationshipAuthority): Promise<RelationshipEvent[]> {
  assertRelationshipAuthority(authority);
  const listed = await store.list(EVENT_PREFIX);
  if (listed.length > RELATIONSHIP_EVENT_SCAN_LIMIT) throw new Error('relationship pilot scan budget exceeded');
  const names = listed.map((item) => relationshipPath(item.name)).sort();
  for (const name of names) {
    if (!/^_MEMORY\/_relationships\/pilot-v1\/events\/rel_evt_[a-f0-9]{64}\.json$/.test(name)) {
      throw new Error(`unexpected object under relationship event prefix: ${name}`);
    }
  }
  const events: RelationshipEvent[] = [];
  for (const name of names) {
    const text = await store.get(name);
    if (text === null) throw new Error(`listed relationship event disappeared: ${name}`);
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { throw new Error(`relationship event is not valid JSON: ${name}`); }
    const event = parseRelationshipEvent(parsed);
    if (name !== `${EVENT_PREFIX}${event.event_id}.json`) throw new Error(`relationship event path and event_id disagree: ${name}`);
    if (canReadRelationshipEvent(authority, event)) {
      events.push(event);
      if (events.length > RELATIONSHIP_EVENT_LIMIT) throw new Error('relationship pilot authorized event cap exceeded');
    }
  }
  return events.sort((a, b) => a.event_id.localeCompare(b.event_id));
}

export async function writeRelationshipEvent(
  store: RelationshipObjectStore,
  authority: RelationshipAuthority,
  proposed: RelationshipEvent,
): Promise<{ event: RelationshipEvent; created: boolean; replayed: boolean; sha256: string }> {
  assertRelationshipAuthority(authority);
  if (proposed.auth.ring !== 'commons' || proposed.auth.owner_agent !== authority.lane || !canWriteRelationshipEvent(authority, proposed)) {
    throw new Error('relationship event is outside server-selected write authority');
  }
  const path = relationshipPath(`${EVENT_PREFIX}${proposed.event_id}.json`);
  const body = canonicalJson(proposed);
  try {
    await store.putIfAbsent(path, body);
    return { event: proposed, created: true, replayed: false, sha256: sha256(body) };
  } catch (error) {
    if (!(error instanceof S3ObjectAlreadyExistsError)) {
      if (error instanceof S3WriteTransportError ||
          (error instanceof S3WriteHttpError && (error.status === 408 || error.status === 429 || error.status >= 500))) {
        throw new RelationshipWriteOutcomeUnknownError();
      }
      throw error;
    }
    const existingText = await store.get(path);
    if (existingText === null) throw new Error(`conditional create conflict but strict read found no object at ${path}`);
    let existingValue: unknown;
    try { existingValue = JSON.parse(existingText); } catch { throw new Error(`existing relationship event is invalid JSON at ${path}`); }
    const existing = parseRelationshipEvent(existingValue);
    if (!canReadRelationshipEvent(authority, existing) || !canWriteRelationshipEvent(authority, existing) ||
        existing.auth.owner_agent !== authority.lane) {
      throw new Error('existing relationship event is outside server-selected authority');
    }
    if (existing.event_id !== proposed.event_id || existing.intent_sha256 !== proposed.intent_sha256) {
      throw new Error(`idempotency key collision at ${path}`);
    }
    const expected = { ...proposed, transaction_time: existing.transaction_time };
    if (canonicalJson(existing) !== canonicalJson(expected)) {
      throw new Error('existing relationship event does not match the immutable operation intent');
    }
    return { event: existing, created: false, replayed: true, sha256: sha256(canonicalJson(existing)) };
  }
}
