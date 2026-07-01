/**
 * GET /health/deep dependency probes.
 *
 * /health (the fast path LB/uptime probes hit) deliberately touches ZERO downstream
 * dependencies, so it can report "ok" while the gateway's actual Cosmos/AI Search/Foundry
 * endpoints are unreachable. That is the exact gap deploy.yml's blue-green gate has: it only
 * asserts /health status + tool_count, so a GREEN revision with a dead dependency can still be
 * promoted to 100% traffic. This module is the bounded, opt-in probe layer for /health/deep and
 * the deploy gate: ONE cheap, timeout-capped reachability GET per CONFIGURED dependency, never a
 * write, never a billed chat/embedding call.
 *
 * Each probe:
 *   - times out at 2s via AbortSignal.timeout(2000) (no dependency on an unmerged fetch helper);
 *   - reports 'unconfigured' (not 'down') when the dependency's env vars are unset, following the
 *     same isConfigured() convention as agentstate/cosmos.ts, azure/search.ts, azure/foundry.ts.
 *     An optional dependency that was never wired must never fail the deploy gate;
 *   - reports 'down' only on a real failure (network error, timeout, or a non-2xx/404 status that
 *     is not the "reachable but empty" case);
 *   - never throws; a probe that itself errors resolves to 'down', it does not reject.
 *
 * Reads process.env directly rather than via config/env.ts's loadEnv(), the same choice
 * governance/charter-enforcer.ts makes for GOVERNANCE_MODE: loadEnv() parses once and caches for
 * the life of the process, so a value read through it can never reflect an app-settings change
 * (or, in tests, a per-test env override) without a full process restart. A dependency health
 * probe is exactly the kind of value that should be re-checked fresh on every call.
 */

import crypto from 'node:crypto';

export type DependencyStatus = 'ok' | 'down' | 'unconfigured';

export interface DeepHealthDeps {
  cosmos: DependencyStatus;
  search: DependencyStatus;
  foundry: DependencyStatus;
}

const PROBE_TIMEOUT_MS = 2000;
/** The always-open, always-present index every configured Search account carries (see
 *  tools/kb/search.ts OPEN_INDEXES). Its /indexes/{name} metadata GET is a cheap, no-query
 *  reachability check, never a search/query call. */
const SEARCH_PROBE_INDEX = 'memory-exec';
const SEARCH_API_VERSION = '2023-11-01';
const FOUNDRY_API_VERSION = '2024-08-01-preview';

/** Mirrors agentstate/cosmos.ts's authToken() (kept in that file; this is a same-shape,
 *  independent implementation so deep-health.ts never imports/mutates the other in-flight
 *  PR's cosmos.ts write/read path, a probe is read-only and out of scope there). Auth
 *  casing is load-bearing, do not "tidy" it; see agentstate/cosmos.ts's own comment. */
function cosmosAuthToken(verb: string, resType: string, resourceLink: string, date: string, masterKey: string): string {
  const stringToSign = `${verb.toLowerCase()}\n${resType.toLowerCase()}\n${resourceLink}\n${date.toLowerCase()}\n\n`;
  const sig = crypto
    .createHmac('sha256', Buffer.from(masterKey, 'base64'))
    .update(stringToSign, 'utf8')
    .digest('base64');
  return encodeURIComponent(`type=master&ver=1.0&sig=${sig}`);
}

async function probeCosmos(): Promise<DependencyStatus> {
  const endpointRaw = process.env.COSMOS_ENDPOINT;
  const key = process.env.COSMOS_KEY;
  if (!endpointRaw || !key) return 'unconfigured';
  try {
    const endpoint = endpointRaw.replace(/\/+$/, '');
    const resourceLink = `dbs/${process.env.COSMOS_DB || 'agent-state'}`;
    const date = new Date().toUTCString();
    const res = await fetch(`${endpoint}/${resourceLink}`, {
      method: 'GET',
      headers: {
        Authorization: cosmosAuthToken('GET', 'dbs', resourceLink, date, key),
        'x-ms-date': date,
        'x-ms-version': '2018-12-31',
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    // A trivial single-doc read of the database resource: 200 means reachable + authenticated.
    // 401/403 (bad key) and 5xx are real reachability/config failures; 404 would mean the
    // configured COSMOS_DB does not exist, also a real failure worth surfacing as 'down'.
    return res.ok ? 'ok' : 'down';
  } catch {
    return 'down';
  }
}

async function probeSearch(): Promise<DependencyStatus> {
  const endpointRaw = process.env.AZURE_SEARCH_ENDPOINT;
  const key = process.env.AZURE_SEARCH_QUERY_KEY;
  if (!endpointRaw || !key) return 'unconfigured';
  try {
    const endpoint = endpointRaw.replace(/\/+$/, '');
    const res = await fetch(
      `${endpoint}/indexes/${SEARCH_PROBE_INDEX}?api-version=${SEARCH_API_VERSION}`,
      {
        method: 'GET',
        headers: { 'api-key': key },
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      },
    );
    return res.ok ? 'ok' : 'down';
  } catch {
    return 'down';
  }
}

async function probeFoundry(): Promise<DependencyStatus> {
  const endpointRaw = process.env.FOUNDRY_OPENAI_ENDPOINT;
  const key = process.env.FOUNDRY_KEY;
  if (!endpointRaw || !key) return 'unconfigured';
  try {
    const endpoint = endpointRaw.replace(/\/+$/, '');
    // The deployments-list endpoint is a cheap metadata GET: it never runs a chat completion or
    // an embedding, so a poll on every deploy / every /health/deep call never burns tokens.
    const res = await fetch(`${endpoint}/openai/deployments?api-version=${FOUNDRY_API_VERSION}`, {
      method: 'GET',
      headers: { 'api-key': key },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    return res.ok ? 'ok' : 'down';
  } catch {
    return 'down';
  }
}

/** Runs all three dependency probes in parallel (each independently timeout-capped, so one slow
 *  dependency never delays the others), and never rejects. */
export async function probeDependencies(): Promise<DeepHealthDeps> {
  const [cosmos, search, foundry] = await Promise.all([probeCosmos(), probeSearch(), probeFoundry()]);
  return { cosmos, search, foundry };
}
