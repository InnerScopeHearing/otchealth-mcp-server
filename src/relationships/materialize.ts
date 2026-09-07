import { canReadRelationshipEvent, type RelationshipAuthority } from './authority.js';
import { canonicalJson, parseRelationshipEvent, utcMillis, type AssertionEvent, type RelationshipEvent } from './schema.js';

export interface MaterializeOptions { asOfValid: string; asOfTransaction: string; includeCandidates?: boolean; }
export function materializeRelationships(rawEvents: readonly unknown[], authority: RelationshipAuthority, options: MaterializeOptions): AssertionEvent[] {
  const validAt = utcMillis(options.asOfValid, 'as_of_valid');
  const transactionAt = utcMillis(options.asOfTransaction, 'as_of_transaction');
  const byEvent = new Map<string, RelationshipEvent>();
  for (const raw of rawEvents) {
    const event = parseRelationshipEvent(raw);
    const previous = byEvent.get(event.event_id);
    if (previous && canonicalJson(previous) !== canonicalJson(event)) throw new Error(`event_id collision: ${event.event_id}`);
    byEvent.set(event.event_id, event);
  }
  const eligible = [...byEvent.values()]
    .filter((event) => utcMillis(event.transaction_time.recorded_at, 'recorded_at') <= transactionAt)
    .filter((event) => canReadRelationshipEvent(authority, event))
    .sort((a, b) => a.transaction_time.recorded_at.localeCompare(b.transaction_time.recorded_at) || a.event_id.localeCompare(b.event_id));
  const assertions = new Map<string, AssertionEvent>();
  for (const event of eligible) {
    if (event.operation !== 'assert') continue;
    const previous = assertions.get(event.relationship_id);
    if (!previous || event.transaction_time.recorded_at < previous.transaction_time.recorded_at) assertions.set(event.relationship_id, event);
  }
  const retiredFrom = new Map<string, number>();
  for (const event of eligible) {
    const target = event.operation === 'retract' ? event.retracts : event.supersedes;
    if (!target || (event.operation === 'assert' && event.assertion_class !== 'fact') || !assertions.has(target)) continue;
    const effective = utcMillis(event.operation === 'retract' ? event.effective_valid_from : event.valid_time.valid_from, 'retirement effective time');
    const previous = retiredFrom.get(target);
    if (previous === undefined || effective < previous) retiredFrom.set(target, effective);
  }
  return [...assertions.values()].filter((event) => {
    if (!options.includeCandidates && event.assertion_class !== 'fact') return false;
    const start = utcMillis(event.valid_time.valid_from, 'valid_from');
    const end = event.valid_time.valid_to === null ? null : utcMillis(event.valid_time.valid_to, 'valid_to');
    if (validAt < start || (end !== null && validAt >= end)) return false;
    const retired = retiredFrom.get(event.relationship_id);
    return retired === undefined || validAt < retired;
  });
}
