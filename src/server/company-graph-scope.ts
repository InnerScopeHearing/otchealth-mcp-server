/**
 * Server-owned graph scope authority for company deployments.
 *
 * Callers may select only a scope identifier. Every security-bearing value is
 * resolved from this closed table. In particular, callers never supply a room,
 * source index, store prefix, worker prefix, or owner identity.
 *
 * Personal legal graph processing is deliberately absent from COMPANY_GRAPH_SCOPES.
 * It may reuse these pure validation interfaces only after a separate privileged
 * deployment supplies distinct storage, registry, credentials, and encryption
 * authority. See PERSONAL_LEGAL_GRAPH_DEPLOYMENT_PREREQUISITES below.
 */

export const COMPANY_GRAPH_SCOPE_IDS = ['finance', 'legal_company'] as const;
export type CompanyGraphScopeId = (typeof COMPANY_GRAPH_SCOPE_IDS)[number];
export type CompanyGraphCaller = 'cfo' | 'clo';

export type CompanyGraphScope = Readonly<{
  scope: CompanyGraphScopeId;
  authenticatedCaller: CompanyGraphCaller;
  room: CompanyGraphScopeId;
  sourceIndex: 'finance-cfo-source-docs' | 'legal-company';
  sourceStore: Readonly<{
    bucket: 'otchealth-finance-legal-dr-55c84f6b';
    prefix: 'otchealthcfodata/cfo-source-docs/' | 'otchealthlegalstore/company/';
  }>;
  workerStore: Readonly<{
    bucket: 'otchealth-finance-legal-dr-55c84f6b';
    prefix: 'graph-trial/20260908/workers/cfo/' | 'graph-trial/20260908/workers/clo/';
  }>;
}>;

const COMPANY_GRAPH_SCOPES: Readonly<Record<CompanyGraphScopeId, CompanyGraphScope>> = Object.freeze({
  finance: Object.freeze({
    scope: 'finance',
    authenticatedCaller: 'cfo',
    room: 'finance',
    sourceIndex: 'finance-cfo-source-docs',
    sourceStore: Object.freeze({
      bucket: 'otchealth-finance-legal-dr-55c84f6b',
      prefix: 'otchealthcfodata/cfo-source-docs/',
    }),
    workerStore: Object.freeze({
      bucket: 'otchealth-finance-legal-dr-55c84f6b',
      prefix: 'graph-trial/20260908/workers/cfo/',
    }),
  }),
  legal_company: Object.freeze({
    scope: 'legal_company',
    authenticatedCaller: 'clo',
    room: 'legal_company',
    sourceIndex: 'legal-company',
    sourceStore: Object.freeze({
      bucket: 'otchealth-finance-legal-dr-55c84f6b',
      prefix: 'otchealthlegalstore/company/',
    }),
    workerStore: Object.freeze({
      bucket: 'otchealth-finance-legal-dr-55c84f6b',
      prefix: 'graph-trial/20260908/workers/clo/',
    }),
  }),
});

export type CompanyGraphScopeResolution =
  | Readonly<{ ok: true; scope: CompanyGraphScope }>
  | Readonly<{ ok: false; code: 'unsupported_scope' | 'scope_forbidden' }>;

/**
 * Resolve a caller-selected scope through the server allow-list.
 *
 * An omitted scope remains `finance`, preserving the existing CFO route
 * contract. CLO company callers select `legal_company` explicitly. Unknown
 * values, `legal-personal`, and `clo-personal` are not company scopes.
 */
export function resolveCompanyGraphScope(
  callerAgent: string | undefined | null,
  requestedScope?: string | null,
): CompanyGraphScopeResolution {
  const id = requestedScope ?? 'finance';
  if (!Object.hasOwn(COMPANY_GRAPH_SCOPES, id)) {
    return Object.freeze({ ok: false, code: 'unsupported_scope' });
  }
  const scope = COMPANY_GRAPH_SCOPES[id as CompanyGraphScopeId];
  if (callerAgent !== scope.authenticatedCaller) {
    return Object.freeze({ ok: false, code: 'scope_forbidden' });
  }
  return Object.freeze({ ok: true, scope });
}

/** Validate the complete caller/room/index/run tuple, not only the caller. */
export function companyGraphScopeOwnsBinding(
  scope: CompanyGraphScope,
  binding: Readonly<{
    authenticated_caller?: unknown;
    room?: unknown;
    source_index?: unknown;
    run?: Readonly<{ scope?: unknown }> | null;
  }>,
): boolean {
  return binding.authenticated_caller === scope.authenticatedCaller &&
    binding.room === scope.room &&
    binding.source_index === scope.sourceIndex &&
    binding.run?.scope === scope.scope;
}

function safeRelativeSuffix(suffix: string): boolean {
  return suffix.length > 0 && suffix.length <= 1024 && suffix === suffix.normalize('NFC') &&
    !suffix.startsWith('/') && !suffix.includes('\\') &&
    !/[\u0000-\u001f\u007f%?#:]/.test(suffix) &&
    suffix.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

/** Exact source-object ownership check. A company scope cannot borrow another scope's prefix. */
export function companyGraphScopeOwnsSourceKey(scope: CompanyGraphScope, key: string): boolean {
  if (!key.startsWith(scope.sourceStore.prefix)) return false;
  return safeRelativeSuffix(key.slice(scope.sourceStore.prefix.length));
}

/** Exact graph-worker ownership check, including traversal and sibling-prefix rejection. */
export function companyGraphScopeOwnsWorkerKey(scope: CompanyGraphScope, key: string): boolean {
  if (!key.startsWith(scope.workerStore.prefix)) return false;
  return safeRelativeSuffix(key.slice(scope.workerStore.prefix.length));
}

/** Metadata checklist only. Presence is not rollout acceptance. */
export const CORPORATE_CLO_GRAPH_ROLLOUT_PREREQUISITES = Object.freeze({
  schema: 'company-graph-rollout-prerequisites-v1',
  scope: 'legal_company',
  authenticated_caller: 'clo',
  source_index: 'legal-company',
  required_configuration_names: Object.freeze([
    'GRAPH_WORKER_BINDINGS_JSON',
    'GRAPH_CATALOG_COHORTS_JSON',
    'GRAPH_RELATIONSHIP_ARTIFACT_POLICY_JSON',
    'GRAPH_RELATIONSHIP_HISTORY_POLICY_JSON',
    'GRAPH_RELATIONSHIP_PUBLICATION_POLICY_JSON',
    'GRAPH_IDENTITY_REGISTRY_CONFIG_JSON',
  ]),
  required_acceptance_receipts: Object.freeze([
    'scope_bound_catalog',
    'version_pinned_source_read',
    'scope_bound_worker_artifact',
    'scope_bound_history_read',
    'identity_registry_currentness',
    'cross_scope_route_denial',
    'fresh_clo_relationship_query',
  ]),
});

export const PERSONAL_LEGAL_GRAPH_DEPLOYMENT_PREREQUISITES = Object.freeze({
  schema: 'personal-legal-graph-deployment-prerequisites-v1',
  scope: 'personal_legal',
  authenticated_caller: 'clo-personal',
  source_index: 'legal-personal',
  deployment_boundary: 'separate_privileged_runtime',
  required_dedicated_authorities: Object.freeze([
    'source_prefix',
    'catalog',
    'worker_artifact_store',
    'relationship_history_store',
    'identity_registry',
    'credential_set',
    'encryption_key',
    'runtime_role',
  ]),
  forbidden_company_reuse: Object.freeze([
    'source_prefix',
    'worker_artifact_prefix',
    'relationship_history_prefix',
    'identity_registry',
    'credential_set',
    'encryption_key',
    'runtime_role',
  ]),
  reusable_code_only: Object.freeze([
    'scope_resolution_interface',
    'binding_validation_algorithm',
    'path_hygiene_algorithm',
    'version_pinning_algorithm',
    'currentness_algorithm',
  ]),
});

export const companyGraphScopeTest = Object.freeze({ scopes: COMPANY_GRAPH_SCOPES });
