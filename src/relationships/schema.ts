import { createHash } from 'node:crypto';
import { z } from 'zod';

export const RELATIONSHIP_SCHEMA = 'otc.relationship.pilot.v1' as const;
export const RELATIONSHIP_PREFIX = '_MEMORY/_relationships/pilot-v1/' as const;
export const RELATIONSHIP_EVENT_LIMIT = 100;
export const RELATIONSHIP_ENTITY_LIMIT = 50;
export const RELATIONSHIP_EDGE_LIMIT = 100;
export const RELATIONSHIP_EVIDENCE_LIMIT = 3;
export const PredicateSchema = z.enum(['depends_on', 'hosted_on', 'replaced_by']);
export type RelationshipPredicate = z.infer<typeof PredicateSchema>;
export const AssertionClassSchema = z.enum(['fact', 'candidate']);
export type AssertionClass = z.infer<typeof AssertionClassSchema>;
export const RingSchema = z.enum(['commons', 'restricted-synthetic']);
export type RelationshipRing = z.infer<typeof RingSchema>;

const HASH = /^[a-f0-9]{64}$/;
const ENTITY = /^synthetic_[a-z0-9_]{1,80}$/;
const UTC = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/;

export function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
export function utcMillis(value: string, field: string): number {
  const match = UTC.exec(value);
  if (!match) throw new Error(`${field} must be a canonical UTC timestamp ending in Z`);
  const millis = Date.parse(value);
  if (!Number.isFinite(millis)) throw new Error(`${field} must be a real UTC timestamp`);
  const fraction = (match[7] || '').padEnd(3, '0');
  const roundTrip = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}.${fraction}Z`;
  if (new Date(millis).toISOString() !== roundTrip) throw new Error(`${field} must be a real UTC timestamp`);
  return millis;
}
const CanonicalUtcSchema = z.string().superRefine((value, ctx) => {
  try { utcMillis(value, 'timestamp'); }
  catch (error) { ctx.addIssue({ code: z.ZodIssueCode.custom, message: error instanceof Error ? error.message : String(error) }); }
});
const EvidenceSchema = z.object({
  source_uri: z.string().regex(/^synthetic:\/\/[a-z0-9_/-]+$/),
  source_sha256: z.string().regex(HASH),
  excerpt_sha256: z.string().regex(HASH),
  locator: z.object({ kind: z.literal('json_pointer'), value: z.string().regex(/^\/[a-z0-9_/-]+$/) }).strict(),
  ring: RingSchema,
  extractor: z.object({ kind: z.literal('deterministic'), name: z.literal('relationship-pilot-fixture'), version: z.literal('1') }).strict(),
}).strict();
const AuthSchema = z.object({
  ring: RingSchema, owner_agent: z.literal('cto'), policy_version: z.literal('relationship-pilot-v1'),
}).strict();
const BaseEventSchema = z.object({
  schema: z.literal(RELATIONSHIP_SCHEMA),
  event_id: z.string().regex(/^rel_evt_[a-f0-9]{64}$/),
  intent_sha256: z.string().regex(HASH),
  fixture_id: z.string().min(1).max(80),
  evidence: z.array(EvidenceSchema).min(1).max(RELATIONSHIP_EVIDENCE_LIMIT),
  transaction_time: z.object({ recorded_at: CanonicalUtcSchema }).strict(),
  auth: AuthSchema,
});
export const AssertionEventSchema = BaseEventSchema.extend({
  operation: z.literal('assert'),
  relationship_id: z.string().regex(/^rel_[a-f0-9]{64}$/),
  subject: z.object({ entity_id: z.string().regex(ENTITY) }).strict(),
  predicate: PredicateSchema,
  object: z.object({ entity_id: z.string().regex(ENTITY) }).strict(),
  assertion_class: AssertionClassSchema,
  resolution: z.object({
    subject: z.object({ status: z.enum(['resolved', 'ambiguous', 'unresolved']) }).strict(),
    object: z.object({ status: z.enum(['resolved', 'ambiguous', 'unresolved']) }).strict(),
  }).strict(),
  valid_time: z.object({ valid_from: CanonicalUtcSchema, valid_to: CanonicalUtcSchema.nullable() }).strict(),
  supersedes: z.string().regex(/^rel_[a-f0-9]{64}$/).optional(),
}).strict().superRefine((event, ctx) => {
  if (event.valid_time.valid_to !== null && utcMillis(event.valid_time.valid_to, 'valid_to') <= utcMillis(event.valid_time.valid_from, 'valid_from')) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'valid_to must be after valid_from' });
  }
  if (event.assertion_class === 'fact' && (event.resolution.subject.status !== 'resolved' || event.resolution.object.status !== 'resolved')) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'facts require resolved endpoints' });
  }
});
export const RetractionEventSchema = BaseEventSchema.extend({
  operation: z.literal('retract'),
  retracts: z.string().regex(/^rel_[a-f0-9]{64}$/),
  effective_valid_from: CanonicalUtcSchema,
}).strict();
export const RelationshipEventSchema = z.union([AssertionEventSchema, RetractionEventSchema]);
export type AssertionEvent = z.infer<typeof AssertionEventSchema>;
export type RelationshipEvent = z.infer<typeof RelationshipEventSchema>;
export function parseRelationshipEvent(value: unknown): RelationshipEvent { return RelationshipEventSchema.parse(value); }
export function eventObjectHash(event: RelationshipEvent): string { return sha256(canonicalJson(event)); }
