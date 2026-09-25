/**
 * CFO finance GraphRAG acceptance contract projection.
 *
 * This module validates the shape and internal consistency of metadata supplied by
 * authorized adapters. It does not authenticate an owner approval receipt or verify
 * adapter provenance, so its receipt can only report `contract_validated`. It must
 * never be presented as a quality acceptance until those independent verifiers are
 * wired to the production readers.
 *
 * Inputs and output are metadata only. Unknown fields are rejected, which prevents
 * callers from accidentally passing source text, paths, URIs, amounts, or PHI.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { sourceCoverageSchema } from '../../brain-capabilities/contracts.js';
import { createGraphCitationReceiptResolver } from './graph-citation-receipts.js';

const HASH = /^[a-f0-9]{64}$/;
const VERSION = /^sha256:[a-f0-9]{64}$/;
const SLOTS = ['x', 'y', 'z', 'negative'] as const;
const NEGATIVE_KINDS = ['reverse', 'missing_bridge', 'near_match', 'personal_ring'] as const;
const ANCHOR_QUERY_SCHEMA = 'cfo-graphrag-negative-query-v1';

const hashSchema = z.string().regex(HASH);
const versionSchema = z.string().regex(VERSION);
const anchorSchema = z.object({ canonical_id: hashSchema, source_version: versionSchema }).strict();
const anchorSetSchema = z.object({ x: anchorSchema, y: anchorSchema, z: anchorSchema, negative: anchorSchema }).strict();
const contractSchema = z.object({
  schema: z.literal('cfo-graphrag-quality-anchor-contract-v1'),
  scope: z.literal('finance'),
  anchors: anchorSetSchema,
  negative_control_kinds: z.array(z.enum(NEGATIVE_KINDS)).length(4),
  contract_sha256: hashSchema,
}).strict();
const bindingSchema = z.object({
  canonical_id: hashSchema,
  source_version: versionSchema,
  authenticated_caller: z.literal('cfo'),
  room: z.literal('finance'),
  source_index: z.literal('finance-cfo-source-docs'),
  run_scope: z.literal('finance'),
  source_current: z.literal(true),
  identity_current: z.literal(true),
  binding_sha256: hashSchema,
  source_current_receipt_sha256: hashSchema,
  identity_current_receipt_sha256: hashSchema,
}).strict();
const citationSchema = anchorSchema;
const citationMappingSchema = z.object({
  canonical_id: hashSchema,
  source_version: versionSchema,
  source_group: z.literal('company'),
  source_sha256: hashSchema,
  source_locator_sha256: hashSchema,
  provenance_receipt_sha256: hashSchema,
}).strict();
const positiveTraversalQuerySchema = z.object({
  schema: z.literal('cfo-graphrag-positive-query-v1'),
  route: z.literal('x_to_y_to_z'),
  anchors: z.object({ x: anchorSchema, y: anchorSchema, z: anchorSchema }).strict(),
}).strict();
const edgeSchema = z.object({
  from: z.enum(['x', 'y', 'z']),
  to: z.enum(['x', 'y', 'z']),
  from_anchor: anchorSchema,
  to_anchor: anchorSchema,
  assertion_sha256: hashSchema,
  evidence_sha256: hashSchema,
  identity_receipt_sha256: hashSchema,
}).strict();
const traversalSchema = z.object({
  scope: z.literal('finance'),
  scan_complete: z.literal(true),
  answer_status: z.literal('qualified'),
  query: positiveTraversalQuerySchema,
  query_sha256: hashSchema,
  artifact_sha256: hashSchema,
  edges: z.array(edgeSchema).length(2),
}).strict();
const controlSchema = z.object({
  kind: z.enum(NEGATIVE_KINDS),
  scope: z.enum(['finance', 'personal']),
  direction: z.enum(['x_to_z', 'z_to_x']),
  bridge_present: z.boolean(),
  exact_identity: z.boolean(),
  anchors: anchorSetSchema,
  query: z.object({
    from: z.enum(['x', 'z']),
    bridge: z.union([z.literal('negative'), z.null()]),
    to: z.enum(['x', 'z']),
  }).strict(),
  query_sha256: hashSchema,
  result_count: z.literal(0),
  result_status: z.enum(['unsupported', 'forbidden_ring']),
  scan_complete: z.boolean().optional(),
  evidence_sha256: hashSchema,
}).strict();
const inputSchema = z.object({
  caller_agent: z.string(),
  contract: contractSchema,
  coverage: sourceCoverageSchema,
  citation_mappings: z.array(citationMappingSchema).length(4),
  bindings: z.array(bindingSchema).length(4),
  citations: z.array(citationSchema).length(4),
  traversal: traversalSchema,
  negative_controls: z.array(controlSchema).length(4),
}).strict();

type Input = z.infer<typeof inputSchema>;
type Rejected = Readonly<{
  schema: 'cfo-graphrag-quality-projection-receipt-v1';
  status: 'rejected';
  quality_state: 'unproven';
  quality_accepted: false;
  blockers: readonly ['invalid_or_incomplete_metadata'];
}>;
export type CfoGraphQualityReceipt = Readonly<{
  schema: 'cfo-graphrag-quality-projection-receipt-v1';
  receipt_id: string;
  status: 'contract_validated';
  quality_state: 'unproven';
  quality_accepted: false;
  owner_approval_verified: false;
  provenance_verified: false;
  inputs_sha256: string;
  contract_sha256: string;
  coverage_counts: Readonly<{ expected: number; processed: number; accepted: number; rejected: number }>;
  declared_citation_count: number;
  declared_binding_count: number;
  declared_edge_count: number;
  declared_negative_control_count: number;
  blockers: readonly ['owner_approval_provenance_unavailable', 'source_owner_signed_metadata_export_unavailable', 'citation_bound_aggregate_graph_receipt_unavailable'];
}>;

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value as object).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
}
function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function pairKey(value: { canonical_id: string; source_version: string }): string { return `${value.canonical_id}\0${value.source_version}`; }
function sorted<T>(values: readonly T[]): T[] {
  return [...values].sort((left, right) => {
    const a = canonical(left), b = canonical(right);
    return a < b ? -1 : a > b ? 1 : 0;
  });
}
function reject(): Rejected {
  return Object.freeze({ schema: 'cfo-graphrag-quality-projection-receipt-v1', status: 'rejected', quality_accepted: false,
    quality_state: 'unproven',
    blockers: Object.freeze(['invalid_or_incomplete_metadata'] as const) });
}

/**
 * Validates a CFO-provided X/Y/Z/negative metadata packet and makes a stable digest.
 * Authentication, contract approval and every referenced adapter receipt still need
 * independent production verifiers. Consequently this function never returns a
 * quality_accepted receipt.
 */
export function projectCfoGraphQualityReceipt(value: unknown): CfoGraphQualityReceipt | Rejected {
  const parsed = inputSchema.safeParse(value);
  if (!parsed.success || parsed.data.caller_agent !== 'cfo') return reject();
  const input: Input = parsed.data;
  const expectedCoverageCount = input.coverage.counts.expected;
  if (input.coverage.coverageStatus !== 'complete' || input.coverage.expectedScope !== 'finance' ||
      expectedCoverageCount === null || expectedCoverageCount < SLOTS.length) return reject();
  const contractBody = {
    schema: input.contract.schema,
    scope: input.contract.scope,
    anchors: input.contract.anchors,
    negative_control_kinds: [...input.contract.negative_control_kinds].sort(),
  };
  if (new Set(input.contract.negative_control_kinds).size !== NEGATIVE_KINDS.length ||
      NEGATIVE_KINDS.some(kind => !input.contract.negative_control_kinds.includes(kind)) ||
      input.contract.contract_sha256 !== hash(canonical(contractBody))) return reject();

  const anchors = SLOTS.map(slot => input.contract.anchors[slot]);
  const anchorKeys = anchors.map(pairKey);
  if (new Set(anchorKeys).size !== SLOTS.length || new Set(anchors.map(anchor => anchor.canonical_id)).size !== SLOTS.length) return reject();
  const anchorByKey = new Set(anchorKeys);

  const mappings = input.citation_mappings;
  if (mappings.some(mapping => mapping.source_version !== `sha256:${mapping.source_sha256}`)) return reject();
  let citations: (string | null)[];
  try {
    const resolveCitation = createGraphCitationReceiptResolver(mappings);
    citations = input.citations.map(citation => {
      if (!anchorByKey.has(pairKey(citation))) return null;
      const resolved = resolveCitation({ caller_agent: 'cfo', canonical_id: citation.canonical_id, source_version: citation.source_version });
      return resolved.status === 'resolved' ? resolved.receipt.receipt_id : null;
    });
  } catch {
    return reject();
  }
  if (citations.length !== SLOTS.length || citations.some(receipt => receipt === null) ||
      new Set(input.citations.map(pairKey)).size !== SLOTS.length) return reject();

  const bindingKeys = input.bindings.map(pairKey);
  if (new Set(bindingKeys).size !== SLOTS.length || bindingKeys.some(key => !anchorByKey.has(key))) return reject();

  const edges = input.traversal.edges;
  const queryAnchors = {
    x: input.contract.anchors.x,
    y: input.contract.anchors.y,
    z: input.contract.anchors.z,
  };
  if (canonical(input.traversal.query.anchors) !== canonical(queryAnchors) ||
      input.traversal.query_sha256 !== hash(canonical(input.traversal.query)) ||
      edges[0].from !== 'x' || edges[0].to !== 'y' ||
      canonical(edges[0].from_anchor) !== canonical(input.contract.anchors.x) ||
      canonical(edges[0].to_anchor) !== canonical(input.contract.anchors.y) ||
      edges[1].from !== 'y' || edges[1].to !== 'z' ||
      canonical(edges[1].from_anchor) !== canonical(input.contract.anchors.y) ||
      canonical(edges[1].to_anchor) !== canonical(input.contract.anchors.z) ||
      new Set(edges.map(edge => `${edge.from}\0${edge.to}`)).size !== 2) return reject();

  const controls = input.negative_controls;
  if (new Set(controls.map(control => control.kind)).size !== NEGATIVE_KINDS.length ||
      NEGATIVE_KINDS.some(kind => !controls.some(control => control.kind === kind)) ||
      controls.some(control => {
        const expected = control.kind === 'reverse'
          ? { scope: 'finance', direction: 'z_to_x', bridge_present: true, exact_identity: true, query: { from: 'z', bridge: 'negative', to: 'x' } }
          : control.kind === 'missing_bridge'
            ? { scope: 'finance', direction: 'x_to_z', bridge_present: false, exact_identity: true, query: { from: 'x', bridge: null, to: 'z' } }
            : control.kind === 'near_match'
              ? { scope: 'finance', direction: 'x_to_z', bridge_present: true, exact_identity: false, query: { from: 'x', bridge: 'negative', to: 'z' } }
              : { scope: 'personal', direction: 'x_to_z', bridge_present: true, exact_identity: true, query: { from: 'x', bridge: 'negative', to: 'z' } };
        const queryDescriptor = {
          schema: ANCHOR_QUERY_SCHEMA,
          kind: control.kind,
          scope: control.scope,
          direction: control.direction,
          bridge_present: control.bridge_present,
          exact_identity: control.exact_identity,
          anchors: control.anchors,
          query: control.query,
        };
        return canonical(control.anchors) !== canonical(input.contract.anchors) ||
          control.query_sha256 !== hash(canonical(queryDescriptor)) ||
          canonical(control.query) !== canonical(expected.query) ||
          control.result_status !== (control.kind === 'personal_ring' ? 'forbidden_ring' : 'unsupported') ||
          (control.kind !== 'personal_ring' && control.scan_complete !== true) ||
          control.scope !== expected.scope || control.direction !== expected.direction ||
          control.bridge_present !== expected.bridge_present || control.exact_identity !== expected.exact_identity;
      })) return reject();

  const normalizedInputs = {
    caller_agent: input.caller_agent,
    contract: { ...contractBody, contract_sha256: input.contract.contract_sha256 },
    coverage: input.coverage,
    citation_mappings: sorted(mappings),
    bindings: sorted(input.bindings),
    citations: sorted(input.citations),
    traversal: input.traversal,
    negative_controls: sorted(controls),
  };
  const inputsSha = hash(canonical(normalizedInputs));
  const blockers = ['owner_approval_provenance_unavailable', 'source_owner_signed_metadata_export_unavailable', 'citation_bound_aggregate_graph_receipt_unavailable'] as const;
  const payload: Omit<CfoGraphQualityReceipt, 'receipt_id'> = {
    schema: 'cfo-graphrag-quality-projection-receipt-v1' as const,
    status: 'contract_validated' as const,
    quality_state: 'unproven' as const,
    quality_accepted: false as const,
    owner_approval_verified: false as const,
    provenance_verified: false as const,
    inputs_sha256: inputsSha,
    contract_sha256: input.contract.contract_sha256,
    coverage_counts: Object.freeze({ ...input.coverage.counts, expected: expectedCoverageCount }),
    declared_citation_count: citations.length,
    declared_binding_count: input.bindings.length,
    declared_edge_count: edges.length,
    declared_negative_control_count: controls.length,
    blockers: Object.freeze(blockers),
  };
  const receiptId = `cfo-gqr_${hash(canonical(payload))}`;
  const receipt: CfoGraphQualityReceipt = { ...payload, receipt_id: receiptId };
  return Object.freeze(receipt);
}
