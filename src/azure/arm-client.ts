/**
 * Azure control-plane client for the gateway, authenticated by the gateway Container App's
 * SYSTEM-ASSIGNED MANAGED IDENTITY (no stored SP secret, no Owner credential in the request path).
 *
 * WHY managed identity and not the azure-sp Owner: the ITEM #2 Azure control-plane lane is
 * deliberately least-privilege. The gateway MI (principalId assigned 2026-07-13) holds EXACTLY:
 *   - Reader            on rg-otchealth-apps-prod + otchealth-automation-rg
 *   - Log Analytics Reader on the log-otchealth-shared workspace
 *   - Search Service Contributor on otchealth-brain-search + otchealth-dataroom-search
 * ...and nothing else (NO Owner, NO Contributor, NO Key Vault Secrets User). Because there is NO
 * AZURE_SP fallback here, the RBAC grant is LOAD-BEARING: if a role is missing the call 403s and the
 * failure is visible, instead of a broad Owner token silently masking a misconfiguration.
 *
 * Three token audiences are used, each minted from the same MI:
 *   - https://management.azure.com   (ARM: jobs, container apps, resources, search key listing)
 *   - https://api.loganalytics.io    (Log Analytics data-plane KQL)
 *   - AI Search data-plane           (a QUERY key obtained via ARM listQueryKeys; read-only)
 *
 * No import-time side effects (reads process.env lazily inside functions) so it is safe under
 * `node --test` and never crashes module load.
 */

import { fetchWithBudget } from '../util/fetch-budget.js';

/** Stable, NON-SECRET Azure identifiers. Overridable via env; defaulted so no deploy-time config is
 *  required for the tools to work (auth comes from the MI, not from these). */
export function azureConfig(): {
  subscriptionId: string;
  logAnalyticsWorkspaceId: string;
  readerResourceGroups: string[];
  searchServices: string[];
} {
  const csv = (v: string | undefined, d: string): string[] =>
    (v || d).split(',').map((s) => s.trim()).filter(Boolean);
  return {
    subscriptionId: process.env.AZURE_SUBSCRIPTION_ID || '55c84f6b-ef90-4259-a58b-50835cc4cab4',
    // customerId (workspace GUID) of log-otchealth-shared in rg-otchealth-shared-prod.
    logAnalyticsWorkspaceId: process.env.LOG_ANALYTICS_WORKSPACE_ID || '2673e0b5-027b-4462-8992-e9f24db05300',
    // The RGs the MI holds Reader on. jobs/resource listing default across these; a target outside
    // them 403s (surfaced, not hidden).
    readerResourceGroups: csv(process.env.AZURE_READER_RGS, 'rg-otchealth-apps-prod,otchealth-automation-rg'),
    // Default = the LIVE S1 service only. The two prior defaults are both DELETED (otchealth-brain-search
    // 2026-07-14, otchealth-dataroom-search 2026-07-20) — a stale default here made the self-diagnostic
    // tools probe dead DNS. Keep this in lockstep with the index-writer registry (expected-indexes.json).
    searchServices: csv(process.env.AZURE_SEARCH_SERVICES, 'otchealth-dataroom-s1'),
  };
}

export const ARM_RESOURCE = 'https://management.azure.com';
export const LOGS_RESOURCE = 'https://api.loganalytics.io';

/**
 * PHI/MNPI ring deny-list. The MedReview PHI ring runs on GCP (not in these Azure RGs) and the MI's
 * RBAC is scoped to non-PHI resources, so PHI is already unreachable here; this is defense in depth,
 * mirroring the PostHog project-468398 block for the Azure tool surface. Any target identifier a
 * caller supplies (job name, index name, container-app name, resource group, KQL-referenced table)
 * that names the PHI ring is refused before any Azure call is made.
 */
// Distinctive PHI tokens match as a SUBSTRING (so `hearing_number_idx`, `medreview-prod` are caught
// even embedded in a longer identifier); the short ambiguous ones (phi/baa) are word-bounded to avoid
// false positives on names like "graphics"/"philadelphia".
const PHI_DENY = /(medreview|med-review|patient|audiogram|hearing[_-]?number)|\b(hipaa|phi|baa)\b/i;

export function assertNonPhiTarget(...ids: Array<string | undefined | null>): void {
  for (const id of ids) {
    if (id && PHI_DENY.test(id)) {
      throw new Error(
        `azure tool refused: target "${id}" matches the PHI-ring deny-list. PHI is BAA-scoped ` +
          `(GCP) and out of scope for the non-PHI gateway.`,
      );
    }
  }
}

interface CachedToken {
  token: string;
  expEpochMs: number;
}
const tokenCache = new Map<string, CachedToken>();

/**
 * Mint a managed-identity access token for `resource` via the Azure Container Apps IMDS endpoint
 * (IDENTITY_ENDPOINT + IDENTITY_HEADER, the MSI successor injected into every replica that runs
 * under a managed identity). Cached per-resource until ~2 min before expiry. FAIL-CLOSED: outside a
 * managed-identity runtime (local/test) IDENTITY_ENDPOINT is unset and this throws a clear message,
 * so the tools are inert rather than silently falling back to a broader credential.
 */
export async function miToken(resource: string): Promise<string> {
  const now = Date.now();
  const cached = tokenCache.get(resource);
  if (cached && cached.expEpochMs - now > 120_000) return cached.token;

  const endpoint = process.env.IDENTITY_ENDPOINT;
  const header = process.env.IDENTITY_HEADER;
  if (!endpoint || !header) {
    throw new Error(
      'managed identity unavailable (IDENTITY_ENDPOINT/IDENTITY_HEADER unset). This Azure ' +
        'control-plane tool only runs inside the gateway Container App, which has a system-assigned ' +
        'identity; it is intentionally inert elsewhere.',
    );
  }
  const url = `${endpoint}?resource=${encodeURIComponent(resource)}&api-version=2019-08-01`;
  const r = await fetchWithBudget(url, { method: 'GET', headers: { 'X-IDENTITY-HEADER': header } });
  if (!r.ok) {
    throw new Error(`managed-identity token request failed (${r.status}) for ${resource}: ${(await r.text()).slice(0, 200)}`);
  }
  const j = (await r.json()) as { access_token?: string; expires_on?: string | number };
  if (!j.access_token) throw new Error(`managed-identity token response missing access_token for ${resource}`);
  const expSec = typeof j.expires_on === 'string' ? parseInt(j.expires_on, 10) : Number(j.expires_on || 0);
  const expEpochMs = Number.isFinite(expSec) && expSec > 0 ? expSec * 1000 : now + 3_600_000;
  tokenCache.set(resource, { token: j.access_token, expEpochMs });
  return j.access_token;
}

export interface ArmResult<T = unknown> {
  status: number;
  ok: boolean;
  body: T | null;
}

/** ARM (management.azure.com) request via the MI token. `path` is an ARM path beginning with '/'.
 *  No DELETE by design (ITEM #2 v1 ships no delete tools). */
export async function armRequest<T = unknown>(
  method: 'GET' | 'POST' | 'PUT' | 'PATCH',
  path: string,
  body?: unknown,
): Promise<ArmResult<T>> {
  const token = await miToken(ARM_RESOURCE);
  const url = path.startsWith('http') ? path : `${ARM_RESOURCE}${path}`;
  const r = await fetchWithBudget(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let parsed: T | null = null;
  const text = await r.text();
  if (text) {
    try {
      parsed = JSON.parse(text) as T;
    } catch {
      parsed = null;
    }
  }
  if (!r.ok) {
    const detail =
      (parsed as { error?: { code?: string; message?: string } } | null)?.error?.message ||
      text.slice(0, 300);
    throw new Error(`ARM ${method} ${path} -> ${r.status}: ${detail}`);
  }
  return { status: r.status, ok: r.ok, body: parsed };
}

/** Run a read-only KQL query against a Log Analytics workspace (data-plane) via the MI token. */
export async function logAnalyticsQuery(
  workspaceId: string,
  kql: string,
  timespan: string,
): Promise<{ columns: string[]; rows: unknown[][]; rowCount: number }> {
  const token = await miToken(LOGS_RESOURCE);
  const url = `${LOGS_RESOURCE}/v1/workspaces/${encodeURIComponent(workspaceId)}/query`;
  const r = await fetchWithBudget(
    url,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: kql, timespan }),
    },
    { timeoutMs: 30_000 },
  );
  if (!r.ok) {
    throw new Error(`Log Analytics query -> ${r.status}: ${(await r.text()).slice(0, 300)}`);
  }
  const j = (await r.json()) as { tables?: Array<{ columns?: Array<{ name: string }>; rows?: unknown[][] }> };
  const table = j.tables?.[0];
  const columns = (table?.columns || []).map((c) => c.name);
  const rows = table?.rows || [];
  return { columns, rows, rowCount: rows.length };
}

/**
 * Obtain a read-only QUERY key for a Search service via ARM listQueryKeys (requires the Search
 * Service Contributor role the MI holds). A query key can ONLY read/query documents; it cannot
 * mutate the index, so even held in memory for one call it is a minimal blast radius. Never logged,
 * never returned to the caller.
 */
export async function searchQueryKey(serviceName: string): Promise<string> {
  const { subscriptionId } = azureConfig();
  // The two search services live in otchealth-automation-rg.
  const rg = process.env.AZURE_SEARCH_RG || 'otchealth-automation-rg';
  const path =
    `/subscriptions/${subscriptionId}/resourceGroups/${rg}/providers/Microsoft.Search/searchServices/` +
    `${serviceName}/listQueryKeys?api-version=2023-11-01`;
  const res = await armRequest<{ value?: Array<{ key?: string }> }>('POST', path);
  const key = res.body?.value?.find((k) => k.key)?.key;
  if (!key) throw new Error(`no query key returned for search service ${serviceName}`);
  return key;
}

/** Exact document count for an index via a read-only count query (search=* , top=0 , count=true). */
export async function searchIndexDocCount(
  serviceName: string,
  indexName: string,
): Promise<number> {
  const key = await searchQueryKey(serviceName);
  const url = `https://${serviceName}.search.windows.net/indexes/${encodeURIComponent(indexName)}/docs/search?api-version=2023-11-01`;
  const r = await fetchWithBudget(url, {
    method: 'POST',
    headers: { 'api-key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ search: '*', top: 0, count: true }),
  });
  if (!r.ok) {
    throw new Error(`search index count (${serviceName}/${indexName}) -> ${r.status}: ${(await r.text()).slice(0, 200)}`);
  }
  const j = (await r.json()) as Record<string, unknown>;
  const count = j['@odata.count'];
  if (typeof count !== 'number') throw new Error(`search index count returned no @odata.count for ${indexName}`);
  return count;
}

// ---------------------------------------------------------------------------------------------------
// Phase B write helpers (typed ARM REST; NO delete, NO az shell-out, NO secret-value surfacing).
// ---------------------------------------------------------------------------------------------------

/** The gateway's own Container App name + the secret whose overwrite took the whole fleet down
 *  (incident 20260713-019). azure_containerapp_set_env hard-refuses to touch it. */
export const GATEWAY_APP_NAME = 'otchealth-mcp-gateway';
const OAUTH_CLIENTS_DENY = /^oauth[-_]?clients$/i;

export interface EnvVarUpsert {
  name: string;
  value?: string;
  secretRef?: string;
}

/**
 * Fail-CLOSED guard for azure_containerapp_set_env. Refuses to touch the gateway's oauth-clients
 * binding (by env-var name OR secretRef), which is the exact overwrite that dropped every connector
 * client fleet-wide. Throws (never silently passes) on a violation.
 */
export function assertContainerAppEnvSafe(appName: string, upserts: EnvVarUpsert[]): void {
  if (appName === GATEWAY_APP_NAME) {
    for (const u of upserts) {
      if (OAUTH_CLIENTS_DENY.test(u.name) || (u.secretRef && OAUTH_CLIENTS_DENY.test(u.secretRef))) {
        throw new Error(
          `azure_containerapp_set_env refused: env "${u.name}"${u.secretRef ? ` (secretRef ${u.secretRef})` : ''} ` +
            `targets the gateway's oauth-clients binding. Overwriting it took every connector down ` +
            `(incident 20260713-019); this tool cannot touch it. A canary guards it; do not defeat it.`,
        );
      }
    }
  }
}

/**
 * NON-DESTRUCTIVE env merge: add/update the upserts into `existing` by name, NEVER dropping any
 * existing var. This is what prevents the "set X and it wiped everything else" failure family. Pure +
 * unit-tested. Returns the merged array + the list of names that were added/changed.
 */
export function mergeEnv(
  existing: Array<Record<string, unknown>>,
  upserts: EnvVarUpsert[],
): { merged: Array<Record<string, unknown>>; changed: string[] } {
  const merged = existing.map((e) => ({ ...e }));
  const changed: string[] = [];
  for (const u of upserts) {
    const entry: Record<string, unknown> = { name: u.name };
    if (u.secretRef) entry.secretRef = u.secretRef;
    else entry.value = u.value ?? '';
    const idx = merged.findIndex((e) => e.name === u.name);
    if (idx >= 0) merged[idx] = entry;
    else merged.push(entry);
    changed.push(u.name);
  }
  return { merged, changed };
}

/**
 * True when the AZURE_SEARCH_ADMIN_KEY direct-key escape hatch below is configured. Lives HERE, next
 * to the only code that uses that key, because this file is the designated Azure adapter allowed to
 * read AZURE_SEARCH_* directly (see search/azure-dependency-guard.test.ts's ENV_VAR_READ_ALLOWED);
 * src/azure/retired.ts asks this instead of reading the variable itself.
 */
export function searchAdminKeyConfigured(): boolean {
  return Boolean((process.env.AZURE_SEARCH_ADMIN_KEY || '').trim());
}

/** Admin key for a Search service via ARM listAdminKeys (Search Service Contributor). Needed for index/
 *  indexer management (query keys cannot manage). Held in memory for one call; never returned/logged. */
export async function searchAdminKey(serviceName: string): Promise<string> {
  // DIRECT-KEY ESCAPE HATCH (2026-08-15, required for the AWS cutover).
  //
  // Everything below this block reaches the admin key via ARM, and ARM auth here is managed
  // identity ONLY (miToken needs IDENTITY_ENDPOINT, injected exclusively into Azure Container Apps
  // replicas). There is no service-principal fallback. So from ECS on AWS this function always
  // throws, and every Azure Search WRITE is impossible -- including the dual-write that is supposed
  // to keep both brains in sync during the migration.
  //
  // That failure is quiet in the worst way: search-write.ts is fail-open, so the write returns
  // {indexed:false} and nothing surfaces. The consequence is that ROLLBACK BECOMES ONE-WAY -- cut
  // over to AWS, run for a day, roll back, and every memory written in that day is stranded in
  // OpenSearch and invisible to an Azure-reading gateway.
  //
  // When AZURE_SEARCH_ADMIN_KEY is provided (an SSM SecureString on the AWS task, exactly like the
  // other 64 secrets), use it directly and skip ARM entirely. Unset, behavior is byte-identical to
  // before: Azure-hosted replicas keep using managed identity and never hold a long-lived key.
  const directKey = (process.env.AZURE_SEARCH_ADMIN_KEY || '').trim();
  if (directKey) return directKey;

  const { subscriptionId } = azureConfig();
  const rg = process.env.AZURE_SEARCH_RG || 'otchealth-automation-rg';
  const path =
    `/subscriptions/${subscriptionId}/resourceGroups/${rg}/providers/Microsoft.Search/searchServices/` +
    `${serviceName}/listAdminKeys?api-version=2023-11-01`;
  const res = await armRequest<{ primaryKey?: string; secondaryKey?: string }>('POST', path);
  const key = res.body?.primaryKey || res.body?.secondaryKey;
  if (!key) throw new Error(`no admin key returned for search service ${serviceName}`);
  return key;
}

/** Data-plane PUT of a Search index or indexer definition, authenticated by an admin key. */
export async function searchResourcePut(
  serviceName: string,
  kind: 'indexes' | 'indexers',
  name: string,
  definition: Record<string, unknown>,
): Promise<{ status: number; body: unknown }> {
  const key = await searchAdminKey(serviceName);
  const url = `https://${serviceName}.search.windows.net/${kind}/${encodeURIComponent(name)}?api-version=2023-11-01`;
  const body = { ...definition, name };
  const r = await fetchWithBudget(url, {
    method: 'PUT',
    headers: { 'api-key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let parsed: unknown = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
  if (!r.ok) {
    const detail = (parsed as { error?: { message?: string } } | null)?.error?.message || text.slice(0, 300);
    throw new Error(`search ${kind} PUT (${serviceName}/${name}) -> ${r.status}: ${detail}`);
  }
  return { status: r.status, body: parsed };
}

/**
 * Redact a Microsoft.App/containerApps GET body to the SAFE, values-stripped shape the
 * azure_containerapp_get tool returns: revision info, image (+ digest if present), scale rules, and
 * env-var NAMES ONLY. Never returns an env-var VALUE or a secret VALUE. Pure + unit-tested.
 */
export function redactContainerApp(body: Record<string, unknown>): Record<string, unknown> {
  const props = (body.properties || {}) as Record<string, unknown>;
  const config = (props.configuration || {}) as Record<string, unknown>;
  const template = (props.template || {}) as Record<string, unknown>;
  const containers = Array.isArray(template.containers) ? (template.containers as Record<string, unknown>[]) : [];
  const scale = (template.scale || {}) as Record<string, unknown>;

  const safeContainers = containers.map((c) => {
    const env = Array.isArray(c.env) ? (c.env as Record<string, unknown>[]) : [];
    return {
      name: c.name,
      image: c.image,
      // env-var NAMES ONLY. For a secretRef binding we surface the secret NAME (a reference, not a
      // value); the literal `value` field is dropped entirely.
      envVarNames: env.map((e) => ({
        name: e.name as string,
        ...(e.secretRef ? { secretRef: e.secretRef as string } : {}),
        fromSecret: Boolean(e.secretRef),
      })),
      resources: c.resources,
    };
  });

  // secret NAMES only (ARM never returns secret values on GET, but strip defensively regardless).
  const secretsRaw = Array.isArray(config.secrets) ? (config.secrets as Record<string, unknown>[]) : [];
  const secretNames = secretsRaw.map((s) => s.name as string).filter(Boolean);

  const ingress = (config.ingress || {}) as Record<string, unknown>;

  return {
    name: body.name,
    resourceGroup: typeof body.id === 'string' ? body.id.split('/')[4] : undefined,
    location: body.location,
    provisioningState: props.provisioningState,
    runningStatus: props.runningStatus,
    latestRevisionName: props.latestRevisionName,
    latestReadyRevisionName: props.latestReadyRevisionName,
    activeRevisionsMode: config.activeRevisionsMode,
    fqdn: ingress.fqdn,
    identity: (body.identity as Record<string, unknown> | undefined)?.type,
    containers: safeContainers,
    scale: { minReplicas: scale.minReplicas, maxReplicas: scale.maxReplicas, rules: scale.rules },
    secretNames,
  };
}

// ---------------------------------------------------------------------------------------------------
// Container Apps JOB helpers (azure_job_get / azure_job_update / azure_job_upsert hardening).
//
// WHY THESE EXIST (incident: the 07-05 daily-digest anomaly). A flurry of full-PUT "Create or Update
// Job" calls that day dropped the job's top-level `identity` (the UAMI) and/or env, so cfo-store could
// no longer read the commons storage key from Key Vault -> "Missing storage key" -> the cron failed
// while a same-day manual run (caught between PUTs) passed. Root lesson: "a PUT that omits a field is
// a deletion", one layer up on a JOB. azure_job_update below does a TARGETED PATCH (never a
// full-replace); redactJob SURFACES the identity so you can SEE whether a job still has its UAMI; and
// computeJobUpsertDrops makes a full-PUT's silent deletions LOUD before they happen.
// ---------------------------------------------------------------------------------------------------

/**
 * Redact a Microsoft.App/jobs GET body to a values-stripped shape: image (+ digest), IDENTITY (type +
 * user-assigned identity resource ids -- ids are references, not secrets, and seeing them is how you
 * diagnose the 07-05 "lost its UAMI" failure), trigger/cron, replica policy, env-var NAMES ONLY, and
 * secret/registry NAMES ONLY. Never returns an env-var VALUE or a secret VALUE. Pure + unit-tested.
 */
export function redactJob(body: Record<string, unknown>): Record<string, unknown> {
  const props = (body.properties || {}) as Record<string, unknown>;
  const config = (props.configuration || {}) as Record<string, unknown>;
  const template = (props.template || {}) as Record<string, unknown>;
  const containers = Array.isArray(template.containers) ? (template.containers as Record<string, unknown>[]) : [];
  const sched = (config.scheduleTriggerConfig || {}) as Record<string, unknown>;
  const identityRaw = (body.identity || {}) as Record<string, unknown>;
  const uami = (identityRaw.userAssignedIdentities || {}) as Record<string, unknown>;

  const safeContainers = containers.map((c) => {
    const env = Array.isArray(c.env) ? (c.env as Record<string, unknown>[]) : [];
    return {
      name: c.name,
      image: c.image,
      envVarNames: env.map((e) => ({
        name: e.name as string,
        ...(e.secretRef ? { secretRef: e.secretRef as string } : {}),
        fromSecret: Boolean(e.secretRef),
      })),
      resources: c.resources,
    };
  });

  const secretsRaw = Array.isArray(config.secrets) ? (config.secrets as Record<string, unknown>[]) : [];
  const registriesRaw = Array.isArray(config.registries) ? (config.registries as Record<string, unknown>[]) : [];

  return {
    name: body.name,
    resourceGroup: typeof body.id === 'string' ? body.id.split('/')[4] : undefined,
    location: body.location,
    provisioningState: props.provisioningState,
    environmentId: props.environmentId,
    identity: {
      type: identityRaw.type || 'None',
      // resource ids only (no values). This is the field whose silent loss caused the 07-05 incident.
      userAssignedIdentities: Object.keys(uami),
    },
    triggerType: config.triggerType,
    cron: sched.cronExpression,
    parallelism: sched.parallelism,
    replicaCompletionCount: sched.replicaCompletionCount,
    replicaTimeout: config.replicaTimeout,
    replicaRetryLimit: config.replicaRetryLimit,
    containers: safeContainers,
    secretNames: secretsRaw.map((s) => s.name as string).filter(Boolean),
    registries: registriesRaw.map((r) => ({ server: r.server, identity: r.identity })),
  };
}

export interface JobPatchChanges {
  image?: string;
  cron?: string;
  replicaTimeout?: number;
  replicaRetryLimit?: number;
}
export interface JobPatchResult {
  patchBody: Record<string, unknown>;
  diff: Array<{ field: string; from: unknown; to: unknown }>;
  touched: string[];
}

/**
 * Build a TARGETED PATCH body for a job update from the LIVE job, changing ONLY the requested fields
 * and preserving everything else. This is the safe realization of "GET-modify-write": it is a PATCH
 * (JSON-merge-patch), never a full-replace PUT, so any field not named here is untouched by
 * construction. For `image` it sends the FULL existing containers array with only [0].image swapped
 * (arrays are replaced wholesale under merge-patch, so a partial container would drop env/resources).
 * For `cron` it sends the full existing scheduleTriggerConfig with only cronExpression changed. Pure +
 * unit-tested; throws if no change is requested or the live job has no container to repoint.
 */
export function applyJobPatch(existing: Record<string, unknown>, changes: JobPatchChanges): JobPatchResult {
  const props = (existing.properties || {}) as Record<string, unknown>;
  const config = (props.configuration || {}) as Record<string, unknown>;
  const template = (props.template || {}) as Record<string, unknown>;
  const containers = Array.isArray(template.containers) ? (template.containers as Record<string, unknown>[]) : [];
  const sched = (config.scheduleTriggerConfig || {}) as Record<string, unknown>;

  const diff: Array<{ field: string; from: unknown; to: unknown }> = [];
  const touched: string[] = [];
  const patchProps: Record<string, unknown> = {};
  const patchConfig: Record<string, unknown> = {};

  if (changes.image !== undefined) {
    if (!containers.length) throw new Error('cannot set image: the live job has no container to repoint.');
    const cloned = JSON.parse(JSON.stringify(containers)) as Record<string, unknown>[];
    const from = cloned[0].image;
    cloned[0].image = changes.image;
    patchProps.template = { containers: cloned };
    diff.push({ field: 'image', from, to: changes.image });
    touched.push('image');
  }
  if (changes.cron !== undefined) {
    const from = sched.cronExpression;
    patchConfig.scheduleTriggerConfig = { ...sched, cronExpression: changes.cron };
    diff.push({ field: 'cron', from, to: changes.cron });
    touched.push('cron');
  }
  if (changes.replicaTimeout !== undefined) {
    diff.push({ field: 'replicaTimeout', from: config.replicaTimeout, to: changes.replicaTimeout });
    patchConfig.replicaTimeout = changes.replicaTimeout;
    touched.push('replicaTimeout');
  }
  if (changes.replicaRetryLimit !== undefined) {
    diff.push({ field: 'replicaRetryLimit', from: config.replicaRetryLimit, to: changes.replicaRetryLimit });
    patchConfig.replicaRetryLimit = changes.replicaRetryLimit;
    touched.push('replicaRetryLimit');
  }
  if (!touched.length) throw new Error('azure_job_update: no change requested (provide at least one of image/cron/replica_timeout/replica_retry_limit).');
  if (Object.keys(patchConfig).length) patchProps.configuration = patchConfig;
  return { patchBody: { properties: patchProps }, diff, touched };
}

export interface JobUpsertDrops {
  droppedIdentity: boolean;
  droppedSecrets: string[];
  droppedEnv: string[];
  droppedRegistries: string[];
  warnings: string[];
}

/**
 * Compute what a full-PUT `azure_job_upsert` would silently DELETE, by diffing the live job against
 * the PUT body. A full replace drops any field the PUT body omits: the top-level identity (the 07-05
 * killer), configuration.secrets, a container's env vars, and configuration.registries. Returns the
 * dropped NAMES (never values) + human-readable warnings, so the dry_run can surface them LOUDLY
 * before anyone applies the PUT. Pure + unit-tested.
 */
export function computeJobUpsertDrops(
  existing: Record<string, unknown> | null,
  putBody: { identity?: unknown; properties?: Record<string, unknown> },
): JobUpsertDrops {
  const warnings: string[] = [];
  if (!existing) {
    return { droppedIdentity: false, droppedSecrets: [], droppedEnv: [], droppedRegistries: [], warnings: [] };
  }
  const eProps = (existing.properties || {}) as Record<string, unknown>;
  const eConfig = (eProps.configuration || {}) as Record<string, unknown>;
  const eTemplate = (eProps.template || {}) as Record<string, unknown>;
  const eIdentity = (existing.identity || {}) as Record<string, unknown>;
  const eUami = Object.keys((eIdentity.userAssignedIdentities || {}) as Record<string, unknown>);
  const eHasIdentity = (eIdentity.type && eIdentity.type !== 'None') || eUami.length > 0;

  const pProps = (putBody.properties || {}) as Record<string, unknown>;
  const pConfig = (pProps.configuration || {}) as Record<string, unknown>;
  const pTemplate = (pProps.template || {}) as Record<string, unknown>;
  const pIdentity = (putBody.identity || {}) as Record<string, unknown>;
  const pUami = Object.keys((pIdentity.userAssignedIdentities || {}) as Record<string, unknown>);
  const pHasIdentity = (pIdentity.type && pIdentity.type !== 'None') || pUami.length > 0;

  const droppedIdentity = Boolean(eHasIdentity && !pHasIdentity);
  if (droppedIdentity) {
    warnings.push(
      `WILL DROP the job's managed identity (${eIdentity.type}${eUami.length ? `, UAMI: ${eUami.map((u) => u.split('/').pop()).join(',')}` : ''}). ` +
        `This is the exact 07-05 failure: without its UAMI the job cannot read Key Vault (storage key, GitHub App JWT). Provide identity in the PUT body to preserve it.`,
    );
  }

  const names = (arr: unknown): string[] =>
    (Array.isArray(arr) ? (arr as Record<string, unknown>[]) : []).map((x) => (x.name || x.server) as string).filter(Boolean);
  const eSecrets = names(eConfig.secrets);
  const pSecrets = new Set(names(pConfig.secrets));
  const droppedSecrets = eSecrets.filter((n) => !pSecrets.has(n));
  if (droppedSecrets.length) warnings.push(`WILL DROP secret(s): ${droppedSecrets.join(', ')}.`);

  const eContainers = Array.isArray(eTemplate.containers) ? (eTemplate.containers as Record<string, unknown>[]) : [];
  const pContainers = Array.isArray(pTemplate.containers) ? (pTemplate.containers as Record<string, unknown>[]) : [];
  const eEnv = names(eContainers[0]?.env);
  const pEnv = new Set(names(pContainers[0]?.env));
  const droppedEnv = eEnv.filter((n) => !pEnv.has(n));
  if (droppedEnv.length) warnings.push(`WILL DROP env var(s) on the primary container: ${droppedEnv.join(', ')}.`);

  const eReg = names(eConfig.registries);
  const pReg = new Set(names(pConfig.registries));
  const droppedRegistries = eReg.filter((n) => !pReg.has(n));
  if (droppedRegistries.length) warnings.push(`WILL DROP registry/registries: ${droppedRegistries.join(', ')} (image pulls may fail).`);

  return { droppedIdentity, droppedSecrets, droppedEnv, droppedRegistries, warnings };
}
