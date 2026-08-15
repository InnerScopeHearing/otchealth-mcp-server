/**
 * done = artifact landed. The resolver that enforces the definition-of-done at the tool boundary.
 *
 * task_complete(artifact_uri) will REJECT unless the artifact_uri actually resolves to something
 * durable. This is what makes "analysis done but nothing committed" and "done = a branch/chat"
 * structurally impossible instead of a convention people forget.
 *
 * Supported artifact_uri schemes (an unrecognized or unresolvable uri is rejected):
 *   blob:<path>                     -> a blob in the Azure commons (company-journal container by
 *   blob:<container>/<path>            default). HEAD must return 200. This is the primary path:
 *                                      agents land durable work-product in the commons.
 *   cosmos:<coll>/<pk>/<id>         -> a document in the agent-state Cosmos db must exist.
 *   https://... (or http://)        -> an HTTP HEAD/GET must return < 400 (public artifacts).
 *   gh:commit:<owner>/<repo>@<sha>  -> a commit must exist.
 *   gh:pr:<owner>/<repo>#<number>   -> a PR must exist.
 *
 * gh: auth (fixed 2026-07-13): prefer a raw GITHUB_TOKEN when set, else fall back to the GitHub
 * App installation token -- the SAME path every github_* tool already uses. Before this, the
 * resolver looked ONLY at GITHUB_TOKEN, which is not configured on the gateway, so EVERY gh:
 * artifact was rejected even though the github_* tools worked fine. Net effect: no task in the
 * fleet could be closed with a GitHub artifact -- the most natural artifact type for engineering
 * work -- so real shipped work was left formally unclosed. Ledger pitfall 20260713-023.
 */

import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import net from 'node:net';
import { loadEnv } from '../config/env.js';
import { readDoc } from './store.js';

/** SSRF guard: reject any IP in a private/reserved/loopback/link-local/metadata range. */
function ipBlocked(ip: string): boolean {
  if (net.isIP(ip) === 4) {
    const p = ip.split('.').map(Number);
    if (p[0] === 10 || p[0] === 127 || p[0] === 0) return true;
    if (p[0] === 169 && p[1] === 254) return true; // link-local + cloud metadata (IMDS)
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
    if (p[0] === 192 && p[1] === 168) return true;
    if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true; // CGNAT
    if (p[0] === 192 && p[1] === 0 && p[2] === 0) return true;
    if (p[0] === 198 && (p[1] === 18 || p[1] === 19)) return true; // benchmarking
    if (p[0] >= 224) return true; // multicast + reserved
    return false;
  }
  const v = ip.toLowerCase().replace(/^\[|\]$/g, '');
  if (v === '::1' || v === '::') return true;
  if (v.startsWith('fe80') || v.startsWith('fc') || v.startsWith('fd')) return true; // link-local + ULA
  const m = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (m) return ipBlocked(m[1]); // IPv4-mapped
  if (v.startsWith('2001:db8')) return true;
  return false;
}

async function hostResolvesSafe(host: string): Promise<boolean> {
  if (net.isIP(host)) return !ipBlocked(host);
  try {
    const addrs = await dns.lookup(host, { all: true });
    return addrs.length > 0 && addrs.every((a) => !ipBlocked(a.address));
  } catch {
    return false;
  }
}

export interface ResolveResult {
  resolved: boolean;
  scheme: string;
  detail: string;
}

function commonsSas(account: string, key: string, perm = 'rl', hours = 1): string {
  const sv = '2021-12-02';
  const ss = 'b';
  const srt = 'co';
  const st = `${new Date(Date.now() - 5 * 60000).toISOString().slice(0, 19)}Z`;
  const se = `${new Date(Date.now() + hours * 3600 * 1000).toISOString().slice(0, 19)}Z`;
  const sts = `${[account, perm, ss, srt, st, se, '', 'https', sv, ''].join('\n')}\n`;
  const sig = crypto.createHmac('sha256', Buffer.from(key, 'base64')).update(sts, 'utf8').digest('base64');
  return new URLSearchParams({ sv, ss, srt, sp: perm, st, se, spr: 'https', sig }).toString();
}

async function resolveBlob(rest: string): Promise<ResolveResult> {
  const env = loadEnv();
  const account = env.AZURE_COMMONS_STORAGE_ACCOUNT;
  const key = env.AZURE_COMMONS_STORAGE_KEY;
  if (!account || !key) {
    return { resolved: false, scheme: 'blob', detail: 'commons storage not configured on the gateway' };
  }
  // Default container is company-journal; allow blob:<container>/<path> as an override.
  const knownContainers = ['company-journal'];
  let container = 'company-journal';
  let path = rest;
  const slash = rest.indexOf('/');
  if (slash > 0 && knownContainers.includes(rest.slice(0, slash))) {
    container = rest.slice(0, slash);
    path = rest.slice(slash + 1);
  }
  const encPath = path.split('/').map((s) => encodeURIComponent(s)).join('/');
  const sas = commonsSas(account, key);
  const url = `https://${account}.blob.core.windows.net/${container}/${encPath}?${sas}`;
  const r = await fetch(url, { method: 'HEAD' });
  return {
    resolved: r.status === 200,
    scheme: 'blob',
    detail: `HEAD ${container}/${path} -> ${r.status}`,
  };
}

const RESOLVE_CONTAINERS = new Set(['tasks', 'memory', 'events']);
const SAFE_SEGMENT = /^[A-Za-z0-9_.\-]+$/;

async function resolveCosmos(rest: string): Promise<ResolveResult> {
  // cosmos:<coll>/<pk>/<id> — coll restricted to the agent-state containers; segments charset-checked.
  const parts = rest.split('/');
  if (parts.length !== 3) {
    return { resolved: false, scheme: 'cosmos', detail: 'expected cosmos:<tasks|memory|events>/<pk>/<id>' };
  }
  const [coll, pk, id] = parts;
  if (!RESOLVE_CONTAINERS.has(coll) || !SAFE_SEGMENT.test(pk) || !SAFE_SEGMENT.test(id)) {
    return { resolved: false, scheme: 'cosmos', detail: 'container must be tasks|memory|events and pk/id must be Cosmos-safe' };
  }
  try {
    const hit = await readDoc(coll, pk, id);
    return { resolved: hit !== null, scheme: 'cosmos', detail: `${coll}/${pk}/${id} -> ${hit ? 'exists' : 'missing'}` };
  } catch (e) {
    return { resolved: false, scheme: 'cosmos', detail: `read failed: ${(e as Error).message}` };
  }
}

async function resolveHttp(uri: string): Promise<ResolveResult> {
  let current: URL;
  try {
    current = new URL(uri);
  } catch {
    return { resolved: false, scheme: 'https', detail: 'invalid url' };
  }
  if (current.protocol !== 'https:') {
    return { resolved: false, scheme: 'https', detail: 'only https:// artifact URLs are allowed' };
  }
  // Manual redirect handling with per-hop SSRF re-validation. (Residual DNS-rebinding TOCTOU is
  // accepted for a convenience scheme; the primary artifact paths are blob:/cosmos:.)
  for (let hop = 0; hop < 4; hop++) {
    if (!(await hostResolvesSafe(current.hostname))) {
      return { resolved: false, scheme: 'https', detail: `host ${current.hostname} resolves to a blocked/internal address` };
    }
    let r: Response;
    try {
      r = await fetch(current.toString(), { method: 'HEAD', redirect: 'manual' });
      if (r.status === 405 || r.status === 501) {
        r = await fetch(current.toString(), { method: 'GET', headers: { Range: 'bytes=0-0' }, redirect: 'manual' });
      }
    } catch {
      return { resolved: false, scheme: 'https', detail: `fetch failed for ${current.hostname}` };
    }
    if (r.status >= 300 && r.status < 400) {
      const loc = r.headers.get('location');
      if (!loc) return { resolved: false, scheme: 'https', detail: `redirect without location from ${current.hostname}` };
      try {
        const next = new URL(loc, current);
        if (next.protocol !== 'https:') return { resolved: false, scheme: 'https', detail: 'redirect to non-https blocked' };
        current = next;
      } catch {
        return { resolved: false, scheme: 'https', detail: 'bad redirect target' };
      }
      continue;
    }
    return { resolved: r.status < 400, scheme: 'https', detail: `${current.hostname} -> ${r.status}` };
  }
  return { resolved: false, scheme: 'https', detail: 'too many redirects' };
}

async function resolveGithub(rest: string): Promise<ResolveResult> {
  const commitM = rest.match(/^commit:([^/]+)\/([^@]+)@(.+)$/);
  const prM = rest.match(/^pr:([^/]+)\/([^#]+)#(\d+)$/);
  if (!commitM && !prM) {
    return { resolved: false, scheme: 'gh', detail: 'expected gh:commit:<owner>/<repo>@<sha> or gh:pr:<owner>/<repo>#<n>' };
  }

  // Path A: an explicit GITHUB_TOKEN, if one is configured (kept for backwards compatibility).
  // loadEnv() THROWS on an incomplete env; this is an enforcement boundary, so a config problem
  // must degrade to a clean "not verified" rejection, never an exception thrown out of
  // task_complete. Fail closed, explain why, never resolve true on error.
  let token: string | undefined;
  try {
    token = loadEnv().GITHUB_TOKEN;
  } catch {
    token = undefined; // fall through to the GitHub App path below
  }
  if (token) {
    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'otchealth-gateway',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    if (commitM) {
      const [, owner, repo, sha] = commitM;
      const r = await fetch(`https://api.github.com/repos/${owner}/${repo}/commits/${sha}`, { method: 'GET', headers });
      return { resolved: r.status === 200, scheme: 'gh', detail: `commit ${owner}/${repo}@${sha.slice(0, 9)} -> ${r.status}` };
    }
    const [, owner, repo, num] = prM!;
    const r = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${num}`, { method: 'GET', headers });
    return { resolved: r.status === 200, scheme: 'gh', detail: `pr ${owner}/${repo}#${num} -> ${r.status}` };
  }

  // Path B (the fix): the GitHub App installation token -- the same client the github_* tools use.
  // Imported LAZILY: api-client.ts validates the whole gateway env at module load, so a static
  // import here would make the resolver unloadable without every unrelated service credential.
  let gh: typeof import('../github/api-client.js');
  try {
    gh = await import('../github/api-client.js');
  } catch (e) {
    return { resolved: false, scheme: 'gh', detail: `github client unavailable: ${(e as Error).message}` };
  }
  const { getCommit, getPullRequest, isGithubAppConfigured } = gh;
  if (!isGithubAppConfigured()) {
    return {
      resolved: false,
      scheme: 'gh',
      detail: 'neither GITHUB_TOKEN nor the GitHub App is configured on the gateway; land the artifact in the commons (blob:) instead',
    };
  }
  try {
    if (commitM) {
      const [, owner, repo, sha] = commitM;
      await getCommit(owner, repo, sha);
      return { resolved: true, scheme: 'gh', detail: `commit ${owner}/${repo}@${sha.slice(0, 9)} -> exists (github app)` };
    }
    const [, owner, repo, num] = prM!;
    await getPullRequest(owner, repo, Number(num));
    return { resolved: true, scheme: 'gh', detail: `pr ${owner}/${repo}#${num} -> exists (github app)` };
  } catch (e) {
    // A 404 (artifact genuinely absent) and a transport/auth failure both mean "not verified" --
    // never resolve on error, or done=artifact stops being an enforcement.
    return { resolved: false, scheme: 'gh', detail: `github app lookup failed: ${(e as Error).message}` };
  }
}

/** Resolve an artifact_uri. Returns resolved=false for anything unrecognized or unreachable. */
export async function resolveArtifact(artifactUri: string): Promise<ResolveResult> {
  const uri = (artifactUri || '').trim();
  if (!uri) return { resolved: false, scheme: 'none', detail: 'artifact_uri is empty' };
  if (uri.startsWith('blob:')) return resolveBlob(uri.slice('blob:'.length));
  if (uri.startsWith('cosmos:')) return resolveCosmos(uri.slice('cosmos:'.length));
  if (uri.startsWith('gh:')) return resolveGithub(uri.slice('gh:'.length));
  if (uri.startsWith('https://') || uri.startsWith('http://')) return resolveHttp(uri);
  return {
    resolved: false,
    scheme: 'unknown',
    detail:
      'unrecognized artifact_uri scheme. Use blob:<path> (commons), cosmos:<coll>/<pk>/<id>, https://..., gh:commit:owner/repo@sha, or gh:pr:owner/repo#n',
  };
}
