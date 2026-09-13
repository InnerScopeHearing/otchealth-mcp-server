import { z } from 'zod';

/** Neutral, storage-agnostic contracts. Runtime code owns persistence and projection behavior. */
const identifier = z.string().regex(
  /^[A-Za-z][A-Za-z0-9._:-]{0,127}$/,
  'must be a stable identifier beginning with a letter',
);
/** External systems own these values. They may be numeric, UUIDs, or provider version strings. */
const opaqueSourceIdentifier = z.string().min(1).max(1_024)
  .refine((value) => !/[\u0000-\u001F\u007F]/.test(value), 'must not contain control characters');
const sha256 = z.string().regex(/^[a-f0-9]{64}$/i, 'must be a SHA-256 hex digest');
const timestamp = z.string().datetime({ offset: true });

export const BRAIN_CONTRACT_VERSION = 'brain.contract.v1' as const;
export const assertionStatusSchema = z.enum(['verified', 'inferred', 'unknown']);
export const assertionLifecycleSchema = z.enum(['active', 'superseded', 'retracted', 'disputed']);
export const memoryTypeSchema = z.enum([
  'session_note',
  'preference',
  'procedure',
  'assertion',
  'decision',
]);
export const authorizationLabelSchema = z.object({
  name: identifier,
  policyVersion: identifier,
}).strict();

/** `unknown` means no valid-time claim; `exact` permits an explicitly open start or end. */
export const timeIntervalSchema = z.object({
  basis: z.enum(['unknown', 'exact']),
  start: timestamp.nullable(),
  end: timestamp.nullable(),
}).strict().superRefine((value, context) => {
  if (value.basis === 'unknown' && (value.start !== null || value.end !== null)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'unknown time has no bounds' });
  }
  if (value.basis === 'exact' && value.start === null && value.end === null) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'exact time requires at least one bound' });
  }
  if (value.start !== null && value.end !== null && Date.parse(value.start) >= Date.parse(value.end)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['end'], message: 'must be after start' });
  }
});

export const evidenceReferenceSchema = z.object({
  evidenceId: identifier,
  sourceSystem: identifier,
  sourceRecordId: opaqueSourceIdentifier,
  immutableVersion: opaqueSourceIdentifier,
  sourceGeneration: opaqueSourceIdentifier,
  actorId: identifier,
  tenantId: identifier,
  contentSha256: sha256,
  span: z.object({
    offsetUnit: z.enum(['utf16', 'codepoint', 'bytes']),
    start: z.number().int().nonnegative(),
    end: z.number().int().positive(),
  }).strict().refine((span) => span.end > span.start, { message: 'end must be after start', path: ['end'] }),
}).strict();

const verificationSchema = z.object({
  method: identifier,
  verifiedAt: timestamp,
  verifier: identifier,
  evidenceIds: z.array(identifier).min(1).max(100),
}).strict();

/** Structural validation only. A successful parse does not establish authority or truth. */
const assertionBaseSchema = z.object({
  contractVersion: z.literal(BRAIN_CONTRACT_VERSION),
  assertionId: identifier,
  recordVersion: identifier,
  actorId: identifier,
  tenantId: identifier,
  sourceGeneration: opaqueSourceIdentifier,
  memoryType: memoryTypeSchema,
  lifecycle: assertionLifecycleSchema,
  statement: z.string().trim().min(1).max(20_000),
  validTime: timeIntervalSchema,
  recordedAt: timestamp,
  recordedUntil: timestamp.nullable(),
  authorization: z.array(authorizationLabelSchema).min(1).max(50)
    .refine((labels) => new Set(labels.map((label) => `${label.name}:${label.policyVersion}`)).size === labels.length,
      'authorization labels must be unique'),
  evidence: z.array(evidenceReferenceSchema).max(100),
});

/** A verified assertion names both its method and its authoritative evidence. */
export const verifiedAssertionSchema = assertionBaseSchema.extend({
  status: z.literal('verified'),
  verification: verificationSchema,
}).strict().superRefine((value, context) => {
  const knownEvidence = new Set(value.evidence.map((evidence) => evidence.evidenceId));
  if (value.evidence.length === 0) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['evidence'], message: 'verified assertions require evidence' });
  }
  for (const evidenceId of value.verification.evidenceIds) {
    if (!knownEvidence.has(evidenceId)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['verification', 'evidenceIds'], message: `unknown evidence ID: ${evidenceId}` });
    }
  }
});

/** Inferred and unknown assertions deliberately cannot carry a verified claim. */
export const nonVerifiedAssertionSchema = assertionBaseSchema.extend({
  status: z.enum(['inferred', 'unknown']),
}).strict().superRefine((value, context) => {
  if (value.recordedUntil !== null && Date.parse(value.recordedAt) >= Date.parse(value.recordedUntil)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['recordedUntil'], message: 'must be after recordedAt' });
  }
  const evidenceIds = value.evidence.map((evidence) => evidence.evidenceId);
  if (new Set(evidenceIds).size !== evidenceIds.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['evidence'], message: 'evidence IDs must be unique' });
  }
});

export const assertionRecordSchema = z.union([verifiedAssertionSchema, nonVerifiedAssertionSchema]);

export const sourceCoverageSchema = z.object({
  contractVersion: z.literal(BRAIN_CONTRACT_VERSION),
  sourceSystem: identifier,
  manifestVersion: identifier,
  expectedScope: z.string().trim().min(1).max(2_000),
  coverageStatus: z.enum(['complete', 'partial', 'failed', 'unknown']),
  observedAt: timestamp,
  counts: z.object({
    expected: z.number().int().nonnegative().nullable(),
    processed: z.number().int().nonnegative(),
    accepted: z.number().int().nonnegative(),
    rejected: z.number().int().nonnegative(),
  }).strict(),
  authoritativeEndReached: z.boolean(),
  unexplainedFailures: z.number().int().nonnegative(),
  cursor: z.string().min(1).max(2_000).optional(),
  watermark: timestamp.optional(),
  contentSha256: sha256.optional(),
}).strict().superRefine((value, context) => {
  const { expected, processed, accepted, rejected } = value.counts;
  if (accepted + rejected > processed) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['counts'], message: 'accepted plus rejected cannot exceed processed' });
  }
  if (value.coverageStatus === 'complete' && (
    expected === null || processed !== expected || accepted !== expected || rejected !== 0
    || !value.authoritativeEndReached || value.unexplainedFailures !== 0
  )) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['coverageStatus'], message: 'complete coverage requires a known accepted scope, authoritative end, and no unexplained failures' });
  }
});

export const idempotencyEnvelopeSchema = z.object({
  contractVersion: z.literal(BRAIN_CONTRACT_VERSION),
  operationId: identifier,
  idempotencyKey: z.string().regex(/^[A-Za-z0-9._:-]{16,256}$/, 'must be a stable idempotency key'),
  actorId: identifier,
  tenantId: identifier,
  requestedAt: timestamp,
  payload: z.unknown(),
}).strict();

export const persistenceReceiptSchema = z.object({
  contractVersion: z.literal(BRAIN_CONTRACT_VERSION),
  operationId: identifier,
  idempotencyKey: z.string().regex(/^[A-Za-z0-9._:-]{16,256}$/),
  receiptId: identifier,
  persistenceState: z.enum(['committed', 'pending', 'rejected', 'not_found', 'unknown']),
  recordedAt: timestamp.optional(),
  recordId: identifier.optional(),
}).strict().superRefine((value, context) => {
  if (value.persistenceState === 'committed' && (!value.recordedAt || !value.recordId)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'committed receipts require recordedAt and recordId' });
  }
  if (value.persistenceState !== 'committed' && (value.recordedAt || value.recordId)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'only committed receipts may identify a persisted record' });
  }
});

export type AssertionRecord = z.infer<typeof assertionRecordSchema>;
export type EvidenceReference = z.infer<typeof evidenceReferenceSchema>;
export type SourceCoverage = z.infer<typeof sourceCoverageSchema>;
export type IdempotencyEnvelope = z.infer<typeof idempotencyEnvelopeSchema>;
export type PersistenceReceipt = z.infer<typeof persistenceReceiptSchema>;
