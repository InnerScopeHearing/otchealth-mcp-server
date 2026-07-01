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
 *   gh:commit:<owner>/<repo>@<sha>  -> a commit must exist (needs GITHUB_TOKEN; else rejected).
 *   gh:pr:<owner>/<repo>#<number>   -> a PR must exist (needs GITHUB_TOKEN; else rejected).
 */

import crypto from 'node:crypto';
import { loadEnv } from '../config/env.js';
import { readDoc } from './cosmos.js';

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

async function resolveCosmos(rest: string): Promise<ResolveResult> {
  // cosmos:<coll>/<pk>/<id>
  const parts = rest.split('/');
  if (parts.length < 3) {
    return { resolved: false, scheme: 'cosmos', detail: 'expected cosmos:<coll>/<pk>/<id>' };
  }
  const [coll, pk, ...idParts] = parts;
  const id = idParts.join('/');
  try {
    const hit = await readDoc(coll, pk, id);
    return { resolved: hit !== null, scheme: 'cosmos', detail: `${coll}/${pk}/${id} -> ${hit ? 'exists' : 'missing'}` };
  } catch (e) {
    return { resolved: false, scheme: 'cosmos', detail: `read failed: ${(e as Error).message}` };
  }
}

async function resolveHttp(uri: string): Promise<ResolveResult> {
  try {
    let r = await fetch(uri, { method: 'HEAD', redirect: 'follow' });
    if (r.status === 405 || r.status === 501) {
      r = await fetch(uri, { method: 'GET', headers: { Range: 'bytes=0-0' }, redirect: 'follow' });
    }
    return { resolved: r.status < 400, scheme: 'https', detail: `HEAD ${uri} -> ${r.status}` };
  } catch (e) {
    return { resolved: false, scheme: 'https', detail: `fetch failed: ${(e as Error).message}` };
  }
}

async function resolveGithub(rest: string): Promise<ResolveResult> {
  const env = loadEnv();
  const token = env.GITHUB_TOKEN;
  if (!token) {
    return {
      resolved: false,
      scheme: 'gh',
      detail: 'GITHUB_TOKEN not configured on the gateway; land the artifact in the commons (blob:) instead',
    };
  }
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'otchealth-gateway',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  const commitM = rest.match(/^commit:([^/]+)\/([^@]+)@(.+)$/);
  if (commitM) {
    const [, owner, repo, sha] = commitM;
    const r = await fetch(`https://api.github.com/repos/${owner}/${repo}/commits/${sha}`, { method: 'GET', headers });
    return { resolved: r.status === 200, scheme: 'gh', detail: `commit ${owner}/${repo}@${sha.slice(0, 9)} -> ${r.status}` };
  }
  const prM = rest.match(/^pr:([^/]+)\/([^#]+)#(\d+)$/);
  if (prM) {
    const [, owner, repo, num] = prM;
    const r = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${num}`, { method: 'GET', headers });
    return { resolved: r.status === 200, scheme: 'gh', detail: `pr ${owner}/${repo}#${num} -> ${r.status}` };
  }
  return { resolved: false, scheme: 'gh', detail: 'expected gh:commit:<owner>/<repo>@<sha> or gh:pr:<owner>/<repo>#<n>' };
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
