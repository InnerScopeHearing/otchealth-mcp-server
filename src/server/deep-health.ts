/**
 * GET /health/deep dependency probes -- BACKEND-AWARE (2026-08-18 rewrite).
 *
 * /health (the fast path LB/uptime probes hit) deliberately touches ZERO downstream dependencies,
 * so it can report "ok" while the gateway's actual dependencies are unreachable. /health/deep is
 * the bounded, opt-in probe layer that closes that gap for the deploy gate (.github/workflows/
 * deploy.yml's "Assert GREEN deep-health" step): one cheap, timeout-capped reachability check per
 * ACTIVE dependency, never a write, never a billed chat/embedding call.
 *
 * WHY THIS FILE WAS REWRITTEN, NOT PATCHED. The pre-2026-08-18 version hardcoded three Azure
 * endpoints (Cosmos, Azure AI Search, Azure Foundry) and read AZURE_SEARCH_*, FOUNDRY_*, COSMOS_*
 * env vars directly, completely ignoring STATE_BACKEND / SEARCH_BACKEND / BLOB_BACKEND /
 * EMBEDDINGS_PROVIDER / LLM_PROVIDER / WEB_SEARCH_PROVIDER -- the six selectors that actually
 * decide which backend is live (src/config/env.ts). Two guard tests
 * (search/azure-dependency-guard.test.ts, agentstate/agentstate-dependency-guard.test.ts) FLAGGED
 * this file by name as a known, un-endorsed violation, precisely because a deploy gate that probes
 * a dependency the running code no longer calls can fail a healthy GREEN revision on a dead
 * dependency, or -- worse -- stay silent about a real failure in the dependency actually serving
 * traffic. Azure subscription 55c84f6b is now PERMANENTLY DELETED (unpayable bill, credits denied;
 * there is no reactivation path), so the old Cosmos/Search/Foundry probes were not merely stale,
 * they were guaranteed-down probes against infrastructure that no longer exists at all -- a gate
 * that would have failed 100% of GREEN deploys had it ever actually run with real credentials, or
 * (if someone "fixed" it by deleting the probes instead of pointing them at the active backend)
 * left the gate checking nothing. Both allow-list entries for this file are removed in this same
 * change; this file no longer reads a single AZURE_*, FOUNDRY_*, or COSMOS_* env var.
 *
 * THE FOUR-STATE CONTRACT PER PROBE, made explicit and structured rather than inferred from a bare
 * string, per the design rule that drove this rewrite: it must be IMPOSSIBLE for a probe to report
 * healthy without having actually run, and an unreachable dependency, a missing/invalid selector,
 * and a probe that never ran must be three distinguishable loud states, never a silent pass.
 *
 *   'ok'            The active, correctly-configured backend was reached and answered as expected.
 *   'down'          The active, correctly-configured backend was reached but failed (network
 *                   error, timeout, auth failure, non-2xx, or an answer that does not look like
 *                   what was asked for). REQUIRED probes in this state fail the gate.
 *   'unconfigured'  ONLY used for a genuinely OPTIONAL dependency (see `required: false` below)
 *                   whose credentials were simply never wired. Never used for a REQUIRED probe --
 *                   once a selector has chosen an active backend, that backend not being reachable
 *                   is a real failure ('down' or 'error'), not an absence to shrug off.
 *   'error'         A CONFIGURATION defect, not a live-reachability failure: the selector env var
 *                   is unset, holds an unrecognised value, or explicitly names the permanently
 *                   retired Azure backend. This is the state that replaces silently defaulting to
 *                   Azure (zod's schema default would otherwise resolve an unset SEARCH_BACKEND to
 *                   'azure' and this probe would then dutifully probe a deleted subscription and
 *                   report a confident, wrong 'down'/'ok'). `error` is always REQUIRED: a
 *                   misconfigured selector on a GREEN deploy is exactly the "points an operator at
 *                   the wrong recovery target" failure this gate exists to catch.
 *
 * Every ProbeResult also carries `required` (does this probe's failure gate the deploy?), `ran`
 * (did a live check actually execute, or did the probe short-circuit before reaching the network?)
 * and, on failure, a structured `error` string -- never prose-only. `probeDependencies()`'s
 * top-level `ok` boolean is derived purely from the structured `required`/`status` fields, so a
 * caller that reads ONLY `ok` sees the identical verdict a caller who reads every `probes[...]`
 * entry would reach; there is no separate prose summary that could drift from the structured
 * truth (the exact mismatch class flagged as a recorded fleet pitfall).
 *
 * SELECTOR READING, DELIBERATELY RAW. Every selector (`*_BACKEND`, `*_PROVIDER`) is read directly
 * off `process.env`, NEVER via `config/env.ts`'s `loadEnv()`. Two independent reasons, both load-
 * bearing: (1) `loadEnv()` parses once and memoizes for the life of the process, so a value read
 * through it can never reflect a live app-settings change (or, in tests, a per-test env override)
 * without a full process restart -- exactly wrong for a probe whose entire job is "what does the
 * CURRENTLY RUNNING configuration actually point at, right now" (this file's own original
 * convention, kept). (2) `loadEnv()`'s zod schema gives every one of these selectors a DEFAULT
 * (e.g. `SEARCH_BACKEND` defaults to `'azure'`), so a genuinely-unset env var would silently
 * resolve to the retired Azure value rather than surfacing as the missing-selector defect it
 * actually is -- the exact failure mode `'error'` above exists to make loud instead. Reading
 * `process.env` raw is the only way to tell "operator deliberately chose azure" apart from
 * "nobody set this at all", which zod's `.default()` collapses into the same value.
 *
 * COST DISCIPLINE. Every network call here is bounded by PROBE_TIMEOUT_MS and issued with
 * `retries: 0` (a probe failing fast and once is more informative than fetchWithBudget's default
 * one-retry-with-backoff, and keeps worst-case gate latency bounded). The OpenAI probes use a
 * bare `GET /v1/models/{id}` metadata call -- genuinely free, no completion/embedding is ever
 * billed. The one exception is the Tavily web-search probe, which (Tavily's API has no free
 * reachability/usage endpoint this file could find) issues one real minimal `/search` call and
 * therefore spends exactly one Tavily credit (~$0.008, or free under the account's 1,000
 * credits/month tier) per deploy-gate run -- flagged explicitly in that probe's own comment rather
 * than glossed over as free.
 */

import pg from 'pg';
import { fetchWithBudget } from '../util/fetch-budget.js';
import { resolveAwsCredentials, signRequest } from '../search/sigv4.js';
import { s3LocationFor } from '../legal/s3-blob-store.js';

export type ProbeStatus = 'ok' | 'down' | 'unconfigured' | 'error';

export interface ProbeResult {
  /** See this file's header for the exact meaning of each state. */
  status: ProbeStatus;
  /** Optional-dependency probes ('unconfigured' is a legitimate resting state for them) never gate
   *  the deploy regardless of their status. Every other probe is required. */
  required: boolean;
  /** True only once a live check actually executed (a network call was made, or -- for the
   *  in-process identity probe -- a real sign/verify round-trip ran). False when the probe
   *  short-circuited before that point (missing selector, missing credential, unconfigured
   *  optional dependency). */
  ran: boolean;
  /** Which concrete backend/provider this probe evaluated (e.g. 'opensearch', 'postgres', 's3',
   *  'openai', 'tavily', 'ssm', 'oauth'), or the raw (invalid/retired) selector value when the
   *  probe never got far enough to resolve one. Always present, even on failure -- this is the
   *  "name the active backend" half of the structured-response requirement. */
  backend: string;
  /** Human-readable context on success. */
  detail?: string;
  /** Structured, always-present-on-failure error string. Never the only surface for the failure --
   *  `status`/`required` alone are already enough for an automated gate to act correctly. */
  error?: string;
}

export interface DeepHealthReport {
  /** True iff every REQUIRED probe's status is 'ok'. The single field a caller needs to gate a
   *  deploy on; every other field exists for diagnosis, not for the pass/fail decision itself. */
  ok: boolean;
  probes: Record<string, ProbeResult>;
}

const PROBE_TIMEOUT_MS = 2500;
/** The always-open, always-present index every configured search backend carries (formerly
 *  Azure-only; the same well-known index exists in the OpenSearch mirror). Used for a zero-result
 *  document search, the cheapest real reachability check available. */
const SEARCH_PROBE_INDEX = 'memory-exec';
/** SHA-256 of the empty string: the required `x-amz-content-sha256` header for a bodyless S3
 *  request. A well-known constant, not a secret -- duplicated here rather than imported from
 *  legal/s3-blob-store.ts to keep this file's AWS calls self-contained and independently
 *  auditable, matching this file's pre-existing convention (see the historical comment on the old
 *  Cosmos auth-token helper this rewrite removed: "independent implementation so deep-health.ts
 *  never imports/mutates the other file's write path"). */
const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

// ── selector resolution ──────────────────────────────────────────────────────────────────────

type SelectorKind = 'missing' | 'invalid' | 'retired' | 'active';

export interface SelectorState {
  raw: string | undefined;
  kind: SelectorKind;
  envVar: string;
  active: string;
  retired: string;
}

/** Resolve one backend-selecting env var against its known active/retired values, reading
 *  process.env DIRECTLY (see this file's header for why). Never defaults -- an unset var is
 *  'missing', not silently 'retired' the way loadEnv()'s zod default would resolve it. */
export function resolveSelector(envVar: string, active: string, retired: string): SelectorState {
  const raw = process.env[envVar];
  if (raw === undefined || raw === '') return { raw, kind: 'missing', envVar, active, retired };
  if (raw === retired) return { raw, kind: 'retired', envVar, active, retired };
  if (raw === active) return { raw, kind: 'active', envVar, active, retired };
  return { raw, kind: 'invalid', envVar, active, retired };
}

/** Build the required, 'error'-status ProbeResult for a selector that is missing, invalid, or
 *  explicitly points at the permanently retired Azure backend. Called only when
 *  `sel.kind !== 'active'`. */
export function selectorErrorResult(sel: SelectorState): ProbeResult {
  if (sel.kind === 'missing') {
    return {
      status: 'error',
      required: true,
      ran: false,
      backend: 'unset',
      error: `${sel.envVar} is not set. Refusing to assume a default -- the schema default ("${sel.retired}") is the permanently retired Azure backend, and probing it would test a dependency that no longer exists (Azure subscription 55c84f6b is deleted).`,
    };
  }
  if (sel.kind === 'retired') {
    return {
      status: 'error',
      required: true,
      ran: false,
      backend: sel.raw ?? sel.retired,
      error: `${sel.envVar}=${sel.raw} points at the permanently retired Azure backend (subscription 55c84f6b is deleted; there is no reactivation path). Set ${sel.envVar}=${sel.active}.`,
    };
  }
  return {
    status: 'error',
    required: true,
    ran: false,
    backend: sel.raw ?? 'unknown',
    error: `${sel.envVar}=${sel.raw} is not a recognised value (expected "${sel.active}" or the retired "${sel.retired}").`,
  };
}

function errAsString(err: unknown, max = 300): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, max);
}

// ── RDS state plane + agent inbox (STATE_BACKEND) ────────────────────────────────────────────

/** Open one short-lived pg.Client bounded by PROBE_TIMEOUT_MS, run `fn`, and always close it --
 *  never reuses/creates the application's own pool (agentstate/postgres.ts, agentstate/
 *  queue-postgres.ts), so a probe failure can never leak a connection into, or be masked by, the
 *  app's real connection pool. */
async function withProbePgClient<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({
    host: process.env.PG_HOST,
    port: process.env.PG_PORT ? Number.parseInt(process.env.PG_PORT, 10) : 5432,
    database: process.env.PG_DATABASE || 'agentstate',
    user: process.env.PG_USER,
    password: process.env.PG_PASSWORD,
    ssl: { rejectUnauthorized: process.env.PG_SSL_VERIFY === 'true' },
    connectionTimeoutMillis: PROBE_TIMEOUT_MS,
    statement_timeout: PROBE_TIMEOUT_MS,
    query_timeout: PROBE_TIMEOUT_MS,
  });
  try {
    await client.connect();
    return await fn(client);
  } finally {
    await client.end().catch(() => undefined);
  }
}

/**
 * RDS state plane + agent-inbox readiness, together (one connection, two required checks) --
 * STATE_BACKEND=postgres.
 *
 * state_rds: a read plus a safe transaction with rollback (BEGIN; SELECT 1; ROLLBACK), proving the
 * connection can actually execute inside a transaction and never leaves a write behind.
 *
 * state_inbox: `SELECT to_regclass('public.agentstate_queue') IS NOT NULL` -- a read-only catalog
 * lookup, not a write, so this never races or interferes with queue-postgres.ts's own idempotent
 * CREATE TABLE IF NOT EXISTS self-provisioning. A missing table is reported as a real 'down', not
 * papered over: agent_dispatch / inbox_read / wake would fail against it right now, and that is
 * exactly the class of "succeeded while doing nothing real" gap this whole rewrite exists to close
 * -- a healthy-looking deploy whose agent inbox has quietly never been provisioned.
 */
export async function probeStateBackends(): Promise<{ state_rds: ProbeResult; state_inbox: ProbeResult }> {
  const sel = resolveSelector('STATE_BACKEND', 'postgres', 'cosmos');
  if (sel.kind !== 'active') {
    const err = selectorErrorResult(sel);
    return { state_rds: err, state_inbox: { ...err } };
  }
  if (!process.env.PG_HOST) {
    const err: ProbeResult = {
      status: 'error',
      required: true,
      ran: false,
      backend: 'postgres',
      error: 'STATE_BACKEND=postgres but PG_HOST is unset -- the state plane has no address to reach.',
    };
    return { state_rds: err, state_inbox: { ...err } };
  }
  try {
    const [rdsOk, inboxReady] = await withProbePgClient(async (client) => {
      await client.query('BEGIN');
      let ok = false;
      let ready = false;
      try {
        const r = await client.query('SELECT 1 AS ok');
        ok = r.rows[0]?.ok === 1;
        const q = await client.query("SELECT to_regclass('public.agentstate_queue') IS NOT NULL AS ready");
        ready = Boolean(q.rows[0]?.ready);
      } finally {
        // Always rollback -- this probe never commits anything, even a no-op SELECT's implicit
        // transaction state, so a probe run can never be mistaken for a real write.
        await client.query('ROLLBACK').catch(() => undefined);
      }
      return [ok, ready];
    });
    return {
      state_rds: {
        status: rdsOk ? 'ok' : 'down',
        required: true,
        ran: true,
        backend: 'postgres',
        detail: rdsOk ? 'BEGIN; SELECT 1; ROLLBACK against the RDS agent-state instance' : undefined,
        error: rdsOk ? undefined : 'SELECT 1 did not return the expected row',
      },
      state_inbox: {
        status: inboxReady ? 'ok' : 'down',
        required: true,
        ran: true,
        backend: 'postgres',
        detail: inboxReady ? 'agentstate_queue table present (to_regclass resolved it)' : undefined,
        error: inboxReady
          ? undefined
          : 'agentstate_queue table does not exist -- agent_dispatch/inbox_read/wake will fail until first real use self-provisions it (queue-postgres.ts ensureSchema)',
      },
    };
  } catch (err) {
    const down: ProbeResult = { status: 'down', required: true, ran: true, backend: 'postgres', error: errAsString(err) };
    return { state_rds: down, state_inbox: { ...down } };
  }
}

// ── OpenSearch (SEARCH_BACKEND) ──────────────────────────────────────────────────────────────

/** A SIGNED, zero-result query against SEARCH_PROBE_INDEX -- the operation a real caller actually
 *  performs (see search/opensearch.ts), so this proves reachability, credentials, AND that the
 *  request actually reached a real OpenSearch domain (checked via the response shape, not just the
 *  HTTP status) rather than some other 200-returning endpoint. */
export async function probeSearch(): Promise<ProbeResult> {
  const sel = resolveSelector('SEARCH_BACKEND', 'opensearch', 'azure');
  if (sel.kind !== 'active') return selectorErrorResult(sel);

  const endpointRaw = process.env.OPENSEARCH_ENDPOINT;
  if (!endpointRaw) {
    return {
      status: 'error',
      required: true,
      ran: false,
      backend: 'opensearch',
      error: 'SEARCH_BACKEND=opensearch but OPENSEARCH_ENDPOINT is unset.',
    };
  }
  const credentials = await resolveAwsCredentials();
  if (!credentials) {
    return {
      status: 'error',
      required: true,
      ran: false,
      backend: 'opensearch',
      error: 'AWS credentials unavailable (neither AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY nor the ECS task-role credential endpoint resolved).',
    };
  }
  const host = endpointRaw.replace(/^https?:\/\//, '').replace(/\/+$/, '');
  const region = process.env.OPENSEARCH_REGION || 'us-east-1';
  const path = `/${SEARCH_PROBE_INDEX}/_search`;
  const body = JSON.stringify({ query: { match_all: {} }, size: 0 });
  try {
    const signed = signRequest({ method: 'POST', host, path, body, region, service: 'es', credentials });
    const res = await fetchWithBudget(
      `https://${host}${path}`,
      { method: 'POST', headers: signed.headers, body },
      { timeoutMs: PROBE_TIMEOUT_MS, retries: 0 },
    );
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { status: 'down', required: true, ran: true, backend: 'opensearch', error: `HTTP ${res.status}: ${text.slice(0, 200)}` };
    }
    const j = (await res.json().catch(() => null)) as { hits?: unknown } | null;
    if (!j || typeof j.hits !== 'object' || j.hits === null) {
      return { status: 'down', required: true, ran: true, backend: 'opensearch', error: 'response did not look like an OpenSearch _search result (no `hits`)' };
    }
    return { status: 'ok', required: true, ran: true, backend: 'opensearch', detail: `signed zero-result _search against "${SEARCH_PROBE_INDEX}"` };
  } catch (err) {
    return { status: 'down', required: true, ran: true, backend: 'opensearch', error: errAsString(err) };
  }
}

// ── S3 document + commons mirror (BLOB_BACKEND) ─────────────────────────────────────────────

/** One bounded (max-keys=1, no pagination) signed ListObjectsV2 against a single mirror mapping.
 *  Never loops -- unlike legal/s3-blob-store.ts's listBlobsFromS3 (built for a real listing UI, up
 *  to 200 pages), a health probe must never risk an unbounded number of requests. */
async function s3ListProbe(account: string, container: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const loc = s3LocationFor(account, container);
  if (!loc) return { ok: false, error: `${account}/${container}: no S3 mirror mapping (refusing to guess a bucket)` };
  const credentials = await resolveAwsCredentials();
  if (!credentials) return { ok: false, error: `${account}/${container}: AWS credentials unavailable` };
  const region = process.env.OPENSEARCH_REGION || 'us-east-1';
  const host = `${loc.bucket}.s3.${region}.amazonaws.com`;
  const query: Record<string, string> = { 'list-type': '2', 'max-keys': '1', prefix: loc.keyPrefix };
  try {
    const signed = signRequest({
      method: 'GET',
      host,
      path: '/',
      query,
      region,
      service: 's3',
      credentials,
      extraHeaders: { 'x-amz-content-sha256': EMPTY_SHA256 },
    });
    const qs = Object.entries(query)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .sort()
      .join('&');
    const res = await fetchWithBudget(`https://${host}/?${qs}`, { method: 'GET', headers: signed.headers }, { timeoutMs: PROBE_TIMEOUT_MS, retries: 0 });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { ok: false, error: `${account}/${container}: HTTP ${res.status} ${text.slice(0, 150)}` };
    }
    const text = await res.text();
    if (!text.includes('<ListBucketResult')) {
      return { ok: false, error: `${account}/${container}: unexpected S3 response shape (no <ListBucketResult>)` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `${account}/${container}: ${errAsString(err, 150)}` };
  }
}

/**
 * BLOB_BACKEND=s3: head/list against the two DISTINCT physical buckets the document store spans,
 * so a mapping or IAM problem scoped to just one of them (e.g. the personal-legal-ring split
 * documented in legal/s3-blob-store.ts) does not hide behind the other bucket happening to work --
 *   - the COMMONS/shared-brain mirror (otchealthcommons/company-journal -> otchealth-brain-dr-*)
 *   - a DOCUMENT room mirror (otchealthcfodata/cfo-source-docs -> otchealth-finance-legal-dr-*)
 * Both calls run in parallel and are independently bounded (max-keys=1, no pagination).
 */
export async function probeBlob(): Promise<ProbeResult> {
  const sel = resolveSelector('BLOB_BACKEND', 's3', 'azure');
  if (sel.kind !== 'active') return selectorErrorResult(sel);

  const [commons, doc] = await Promise.all([
    s3ListProbe('otchealthcommons', 'company-journal'),
    s3ListProbe('otchealthcfodata', 'cfo-source-docs'),
  ]);
  const failures = [commons, doc].filter((r): r is { ok: false; error: string } => !r.ok);
  if (failures.length > 0) {
    return { status: 'down', required: true, ran: true, backend: 's3', error: failures.map((f) => f.error).join('; ').slice(0, 400) };
  }
  return { status: 'ok', required: true, ran: true, backend: 's3', detail: 'bounded ListObjectsV2 against the commons mirror and a document-room mirror (2 distinct buckets)' };
}

// ── OpenAI embeddings + chat (EMBEDDINGS_PROVIDER / LLM_PROVIDER) ───────────────────────────

/** GET /v1/models/{id} -- a metadata call, genuinely free (no completion/embedding is billed),
 *  and proves auth + reachability + that the specific model id is actually available under this
 *  key, which a bare `/v1/models` list would not (a key can be valid while a specific deployment
 *  id is not, e.g. FOUNDRY_CHAT_DEPLOYMENT's name guessed wrong on the OpenAI side -- see
 *  azure/foundry.ts's own header for why that mapping is a documented judgement call). */
async function openaiModelReachable(model: string, apiKey: string): Promise<{ ok: boolean; status: number; error?: string }> {
  try {
    const res = await fetchWithBudget(
      `https://api.openai.com/v1/models/${encodeURIComponent(model)}`,
      { method: 'GET', headers: { Authorization: `Bearer ${apiKey}` } },
      { timeoutMs: PROBE_TIMEOUT_MS, retries: 0 },
    );
    if (res.ok) return { ok: true, status: res.status };
    const text = await res.text().catch(() => '');
    return { ok: false, status: res.status, error: text.slice(0, 200) };
  } catch (err) {
    return { ok: false, status: 0, error: errAsString(err, 200) };
  }
}

export async function probeEmbeddings(): Promise<ProbeResult> {
  const sel = resolveSelector('EMBEDDINGS_PROVIDER', 'openai', 'foundry');
  if (sel.kind !== 'active') return selectorErrorResult(sel);

  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    return { status: 'error', required: true, ran: false, backend: 'openai', error: 'EMBEDDINGS_PROVIDER=openai but OPENAI_API_KEY is unset.' };
  }
  // Pinned, not configurable -- must match the model the 492k-doc OpenSearch index was built with
  // (see azure/foundry.ts embeddingsTarget()'s own comment for why this is never overridable).
  const model = 'text-embedding-3-large';
  const r = await openaiModelReachable(model, key);
  return r.ok
    ? { status: 'ok', required: true, ran: true, backend: 'openai', detail: `model "${model}" reachable` }
    : { status: 'down', required: true, ran: true, backend: 'openai', error: `model "${model}": HTTP ${r.status} ${r.error ?? ''}`.trim() };
}

export async function probeLlm(): Promise<ProbeResult> {
  const sel = resolveSelector('LLM_PROVIDER', 'openai', 'foundry');
  if (sel.kind !== 'active') return selectorErrorResult(sel);

  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    return { status: 'error', required: true, ran: false, backend: 'openai', error: 'LLM_PROVIDER=openai but OPENAI_API_KEY is unset.' };
  }
  // Mirrors azure/foundry.ts's openaiModelForTier() fallback chain (standard falls back to the
  // literal default; high falls back to standard's override before its own literal default).
  const standardModel = process.env.OPENAI_CHAT_MODEL || 'gpt-5.1';
  const highModel = process.env.OPENAI_HIGH_MODEL || process.env.OPENAI_CHAT_MODEL || 'gpt-5.4';
  const [std, high] = await Promise.all([openaiModelReachable(standardModel, key), openaiModelReachable(highModel, key)]);
  const failed: string[] = [];
  if (!std.ok) failed.push(`standard("${standardModel}"): HTTP ${std.status} ${std.error ?? ''}`.trim());
  if (!high.ok) failed.push(`high("${highModel}"): HTTP ${high.status} ${high.error ?? ''}`.trim());
  if (failed.length > 0) {
    return { status: 'down', required: true, ran: true, backend: 'openai', error: failed.join('; ').slice(0, 400) };
  }
  return { status: 'ok', required: true, ran: true, backend: 'openai', detail: `models "${standardModel}", "${highModel}" both reachable` };
}

// ── web search (WEB_SEARCH_PROVIDER) ─────────────────────────────────────────────────────────

/** One minimal, real Tavily search -- see this file's header for the cost note (~$0.008/run,
 *  spent because Tavily has no free reachability-only endpoint this file could find). */
export async function probeWebSearch(): Promise<ProbeResult> {
  const sel = resolveSelector('WEB_SEARCH_PROVIDER', 'tavily', 'azure');
  if (sel.kind !== 'active') return selectorErrorResult(sel);

  const key = process.env.TAVILY_API_KEY;
  if (!key) {
    return { status: 'error', required: true, ran: false, backend: 'tavily', error: 'WEB_SEARCH_PROVIDER=tavily but TAVILY_API_KEY is unset.' };
  }
  try {
    const res = await fetchWithBudget(
      'https://api.tavily.com/search',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: 'otchealth gateway deploy health check', include_answer: false, search_depth: 'basic', max_results: 1 }),
      },
      { timeoutMs: PROBE_TIMEOUT_MS, retries: 0 },
    );
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { status: 'down', required: true, ran: true, backend: 'tavily', error: `HTTP ${res.status}: ${text.slice(0, 200)}` };
    }
    return { status: 'ok', required: true, ran: true, backend: 'tavily', detail: 'search reachable (spent 1 Tavily credit)' };
  } catch (err) {
    return { status: 'down', required: true, ran: true, backend: 'tavily', error: errAsString(err) };
  }
}

// ── SSM parameter access from the ECS task role ─────────────────────────────────────────────

/**
 * GetParametersByPath(/otchealth/, MaxResults=1, WithDecryption=false) -- read-only metadata,
 * never decrypts a SecureString value, bounded to exactly one result. Not gated by a selector (no
 * env var chooses "whether" the task role can reach SSM); this always runs as a general canary for
 * the task role's AWS reachability, independent of which data-plane backend is active. The task
 * role (infra/aws/iam.tf's `task_runtime_access` policy, distinct from the execution role that
 * only handles container-startup secret injection) is explicitly granted
 * ssm:GetParameter[s][ByPath] on arn:aws:ssm:*:*:parameter/otchealth/*, so a failure here is a real
 * IAM/network problem for the RUNNING app, not merely a deploy-time secrets-injection issue.
 */
export async function probeSsm(): Promise<ProbeResult> {
  const credentials = await resolveAwsCredentials();
  if (!credentials) {
    return { status: 'error', required: true, ran: false, backend: 'ssm', error: 'AWS credentials unavailable for the task role.' };
  }
  const region = process.env.OPENSEARCH_REGION || 'us-east-1';
  const host = `ssm.${region}.amazonaws.com`;
  const body = JSON.stringify({ Path: '/otchealth/', MaxResults: 1, WithDecryption: false });
  try {
    const signed = signRequest({
      method: 'POST',
      host,
      path: '/',
      body,
      region,
      service: 'ssm',
      credentials,
      extraHeaders: { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': 'AmazonSSM.GetParametersByPath' },
    });
    const res = await fetchWithBudget(`https://${host}/`, { method: 'POST', headers: signed.headers, body }, { timeoutMs: PROBE_TIMEOUT_MS, retries: 0 });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { status: 'down', required: true, ran: true, backend: 'ssm', error: `HTTP ${res.status}: ${text.slice(0, 200)}` };
    }
    const j = (await res.json().catch(() => null)) as { Parameters?: unknown[] } | null;
    if (!j || !Array.isArray(j.Parameters)) {
      return { status: 'down', required: true, ran: true, backend: 'ssm', error: 'response did not look like a GetParametersByPath result (no `Parameters` array)' };
    }
    return { status: 'ok', required: true, ran: true, backend: 'ssm', detail: `GetParametersByPath(/otchealth/, MaxResults=1, WithDecryption=false) -> ${j.Parameters.length} parameter(s)` };
  } catch (err) {
    return { status: 'down', required: true, ran: true, backend: 'ssm', error: errAsString(err) };
  }
}

// ── identity: OAuth signing + lane mapping ──────────────────────────────────────────────────

/**
 * In-process only, no network call: the gateway's OWN client_credentials tokens are stateless
 * HS256 JWTs it signs and verifies itself (auth/oauth-tokens.ts), so the meaningful reachability
 * check is "can this replica actually sign and verify its own tokens right now", not a call to any
 * external IdP. Mints a synthetic canary token, verifies the round-trip, then feeds its scope
 * through the real lane-mapping function (auth/descope.ts laneFromScope) and asserts it resolves
 * to the lane every real "mcp:infra.admin" token depends on -- catching both a broken/rotated
 * signing secret AND a silently misconfigured DESCOPE_SCOPE_LANE_MAP in one check.
 */
export async function probeIdentity(): Promise<ProbeResult> {
  const secret = process.env.OAUTH_TOKEN_SIGNING_SECRET;
  if (!secret) {
    return {
      status: 'error',
      required: true,
      ran: false,
      backend: 'oauth',
      error: 'OAUTH_TOKEN_SIGNING_SECRET is unset -- no gateway-issued client_credentials token can be minted or verified.',
    };
  }
  try {
    const { signToken, verifyToken } = await import('../auth/oauth-tokens.js');
    const { laneFromScope } = await import('../auth/descope.js');
    const canaryScope = 'mcp:infra.admin';
    const canarySub = '__deep_health_canary__';
    const now = Math.floor(Date.now() / 1000);
    const token = signToken(
      { iss: 'deep-health-probe', aud: 'otchealth-mcp', sub: canarySub, scope: canaryScope, agent: 'cto', typ: 'access', exp: now + 60 },
      secret,
    );
    const claims = verifyToken(token, secret);
    if (!claims || claims.sub !== canarySub || claims.scope !== canaryScope) {
      return { status: 'down', required: true, ran: true, backend: 'oauth', error: 'sign/verify round-trip did not return the expected claims' };
    }
    const lane = laneFromScope(canaryScope);
    if (lane !== 'cto') {
      return {
        status: 'down',
        required: true,
        ran: true,
        backend: 'oauth',
        error: `laneFromScope("${canaryScope}") resolved to ${JSON.stringify(lane)}, expected "cto" -- the scope->lane map (DESCOPE_SCOPE_LANE_MAP) may be misconfigured`,
      };
    }
    return { status: 'ok', required: true, ran: true, backend: 'oauth', detail: 'HS256 sign/verify round-trip + scope->lane mapping both verified in-process' };
  } catch (err) {
    return { status: 'down', required: true, ran: true, backend: 'oauth', error: errAsString(err) };
  }
}

// ── optional services (never gate the deploy) ───────────────────────────────────────────────

/** Sentry -- clearly-labelled OPTIONAL (required: false). A real, cheap GET (organization detail,
 *  no data mutation) when configured; 'unconfigured' (not an error) when SENTRY_AUTH_TOKEN was
 *  simply never wired, since Sentry is secondary observability, not a gateway runtime dependency
 *  (see the fleet's own PostHog-primary/Sentry-secondary posture). */
export async function probeSentryOptional(): Promise<ProbeResult> {
  const token = process.env.SENTRY_AUTH_TOKEN;
  const org = process.env.SENTRY_ORG || 'otchealth-inc';
  if (!token) {
    return { status: 'unconfigured', required: false, ran: false, backend: 'sentry' };
  }
  try {
    const res = await fetchWithBudget(
      `https://us.sentry.io/api/0/organizations/${encodeURIComponent(org)}/`,
      { method: 'GET', headers: { Authorization: `Bearer ${token}` } },
      { timeoutMs: PROBE_TIMEOUT_MS, retries: 0 },
    );
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { status: 'down', required: false, ran: true, backend: 'sentry', error: `HTTP ${res.status}: ${text.slice(0, 150)}` };
    }
    return { status: 'ok', required: false, ran: true, backend: 'sentry', detail: `organization "${org}" reachable` };
  } catch (err) {
    return { status: 'down', required: false, ran: true, backend: 'sentry', error: errAsString(err, 200) };
  }
}

// ── aggregate ────────────────────────────────────────────────────────────────────────────────

/**
 * Pure gate-verdict derivation: true iff every REQUIRED probe's status is 'ok'. Extracted so both
 * `probeDependencies()` below AND an external caller (deploy.yml's gate step re-derives this
 * independently from the same `probes` map, rather than trusting the server-computed `ok` alone --
 * see that step's own comment for why) compute the IDENTICAL verdict from the IDENTICAL structured
 * fields, and so this one piece of gating logic has a single, directly unit-testable home.
 */
export function deriveOk(probes: Record<string, ProbeResult>): boolean {
  return Object.values(probes).every((p) => !p.required || p.status === 'ok');
}

/**
 * Runs every probe in parallel (each independently timeout-capped, so one slow dependency never
 * delays the others), never rejects, and derives `ok` purely from `required`/`status` -- see this
 * file's header for the full contract.
 */
export async function probeDependencies(): Promise<DeepHealthReport> {
  const [stateBackends, search, blob, embeddings, llm, webSearch, ssm, identity, sentry] = await Promise.all([
    probeStateBackends(),
    probeSearch(),
    probeBlob(),
    probeEmbeddings(),
    probeLlm(),
    probeWebSearch(),
    probeSsm(),
    probeIdentity(),
    probeSentryOptional(),
  ]);

  const probes: Record<string, ProbeResult> = {
    state_rds: stateBackends.state_rds,
    state_inbox: stateBackends.state_inbox,
    search_opensearch: search,
    blob_s3: blob,
    embeddings_openai: embeddings,
    llm_openai: llm,
    web_search_tavily: webSearch,
    ssm,
    identity_oauth: identity,
    sentry,
  };

  return { ok: deriveOk(probes), probes };
}
