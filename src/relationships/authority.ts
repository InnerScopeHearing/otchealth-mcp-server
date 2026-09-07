import type { ToolContext } from '../tools/registry.js';
import type { RelationshipEvent, RelationshipRing } from './schema.js';

const authorityBrand: unique symbol = Symbol('relationship-authority');
export type RelationshipPilotMode = 'off' | 'synthetic';
export interface RelationshipAuthority {
  readonly [authorityBrand]: true;
  readonly lane: 'cto';
  readonly readableRings: ReadonlySet<RelationshipRing>;
  readonly writableRings: ReadonlySet<RelationshipRing>;
  readonly policyVersion: 'relationship-pilot-v1';
}
export function parseRelationshipPilotMode(value: string | undefined): RelationshipPilotMode {
  return (value || '').trim().toLowerCase() === 'synthetic' ? 'synthetic' : 'off';
}
export function requireRelationshipPilotAuthority(
  ctx: Pick<ToolContext, 'callerAgent'>,
  mode = parseRelationshipPilotMode(process.env.RELATIONSHIP_PILOT_MODE),
): RelationshipAuthority {
  if (mode !== 'synthetic') throw new Error('relationship pilot is disabled');
  if (ctx.callerAgent !== 'cto') throw new Error('relationship pilot requires the authenticated cto lane');
  return Object.freeze({
    [authorityBrand]: true as const,
    lane: 'cto' as const,
    readableRings: new Set<RelationshipRing>(['commons']),
    writableRings: new Set<RelationshipRing>(['commons']),
    policyVersion: 'relationship-pilot-v1' as const,
  });
}
export function assertRelationshipAuthority(authority: RelationshipAuthority): void {
  if (!authority || authority[authorityBrand] !== true || authority.lane !== 'cto') throw new Error('valid server-selected relationship authority is required');
}
export function canReadRelationshipEvent(authority: RelationshipAuthority, event: RelationshipEvent): boolean {
  assertRelationshipAuthority(authority);
  return authority.readableRings.has(event.auth.ring) && event.evidence.every((item) => authority.readableRings.has(item.ring));
}
export function canWriteRelationshipEvent(authority: RelationshipAuthority, event: RelationshipEvent): boolean {
  assertRelationshipAuthority(authority);
  return authority.writableRings.has(event.auth.ring) && event.evidence.every((item) => authority.writableRings.has(item.ring));
}
