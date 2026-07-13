import { createSign } from 'node:crypto';
import { loadEnv } from '../config/env.js';
import { fetchWithBudget } from '../util/fetch-budget.js';

const env = loadEnv();

export class GitHubApiError extends Error {
  readonly code: string; readonly status: number; readonly nextStep: string;
  constructor(a: { code: string; status: number; message: string; nextStep: string }) {
    super(a.message); this.name = 'GitHubApiError'; this.code = a.code; this.status = a.status; this.nextStep = a.nextStep;
  }
}

function b64url(x: object): string {
  return Buffer.from(JSON.stringify(x)).toString('base64url');
}

function mintJwt(): string {
  const appId = env.GITHUB_APP_ID;
  const privateKey = env.GITHUB_APP_PRIVATE_KEY;
  if (!appId) throw new GitHubApiError({ code: 'github_not_configured', status: 0, message: 'GITHUB_APP_ID not set.', nextStep: 'Add GITHUB_APP_ID to the vault.' });
  if (!privateKey) throw new GitHubApiError({ code: 'github_not_configured', status: 0, message: 'GITHUB_APP_PRIVATE_KEY not set.', nextStep: 'Add GITHUB_APP_PRIVATE_KEY to the vault.' });
  const now = Math.floor(Date.now() / 1000);
  const header = b64url({ alg: 'RS256', typ: 'JWT' });
  const payload = b64url({ iat: now - 60, exp: now + 540, iss: appId });
  const data = `${header}.${payload}`;
  const sig = createSign('RSA-SHA256').update(data).sign(privateKey, 'base64url');
  return `${data}.${sig}`;
}

const GITHUB_HEADERS = {
  Accept: 'application/vnd.github+json',
  'User-Agent': 'otchealth-mcp-gateway',
  'X-GitHub-Api-Version': '2022-11-28',
};

// Installation token cache
let cachedToken: string | null = null;
let tokenExpiresAt = 0;

async function getInstallationToken(): Promise<string> {
  const now = Date.now();
  // Reuse until ~1 min before expiry
  if (cachedToken && now < tokenExpiresAt - 60_000) return cachedToken;

  const installationId = env.GITHUB_APP_INSTALLATION_ID;
  if (!installationId) throw new GitHubApiError({ code: 'github_not_configured', status: 0, message: 'GITHUB_APP_INSTALLATION_ID not set.', nextStep: 'Add GITHUB_APP_INSTALLATION_ID to the vault.' });

  const jwt = mintJwt();
  const url = `https://api.github.com/app/installations/${encodeURIComponent(installationId)}/access_tokens`;
  // Token mint is a POST but has no side effect on GitHub state; still, be conservative
  // and do not retry (a second identical mint is wasted, not harmful, but avoids doubt).
  const res = await fetchWithBudget(url, {
    method: 'POST',
    headers: { ...GITHUB_HEADERS, Authorization: `Bearer ${jwt}` },
  }, { retries: 0 });
  const statusCode = res.status;
  const text = await res.text();
  let data: any;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (statusCode >= 400) throw new GitHubApiError({ code: `github_${statusCode}`, status: statusCode, message: data?.message || `HTTP ${statusCode}`, nextStep: 'Verify GitHub App credentials and installation ID.' });

  cachedToken = data.token as string;
  // GitHub installation tokens expire after 1 hour; default to 55 min from now if no expires_at
  const expiresAt: string | undefined = data.expires_at;
  tokenExpiresAt = expiresAt ? new Date(expiresAt).getTime() : now + 55 * 60 * 1000;
  return cachedToken;
}

async function githubGet<T = any>(path: string): Promise<T> {
  const token = await getInstallationToken();
  // Read-only GET: safe to retry once on a network blip / 429 / 5xx.
  const res = await fetchWithBudget(`https://api.github.com${path}`, {
    method: 'GET',
    headers: { ...GITHUB_HEADERS, Authorization: `Bearer ${token}` },
  }, { retries: 1 });
  const statusCode = res.status;
  const text = await res.text();
  let data: any;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (statusCode >= 400) throw new GitHubApiError({ code: `github_${statusCode}`, status: statusCode, message: data?.message || `HTTP ${statusCode}`, nextStep: 'Verify GitHub App installation has access to this repository.' });
  return data as T;
}

export async function listPullRequests(owner: string, repo: string, state = 'open'): Promise<any[]> {
  const data = await githubGet<any[]>(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls?state=${encodeURIComponent(state)}&per_page=20`);
  return Array.isArray(data) ? data : [];
}

export async function listWorkflowRuns(owner: string, repo: string): Promise<any[]> {
  const data = await githubGet<{ workflow_runs: any[] }>(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/runs?per_page=20`);
  return Array.isArray(data?.workflow_runs) ? data.workflow_runs : [];
}

// ── Writes (App installation token; CTO-gated at the tool layer) ───────────────
async function githubSend<T = any>(method: 'POST' | 'PATCH' | 'PUT', path: string, body: unknown): Promise<T> {
  const token = await getInstallationToken();
  // Non-idempotent write (creates/updates a branch, file, PR, comment, merge, etc.):
  // retries:0 so a timeout never causes a duplicate GitHub mutation.
  const res = await fetchWithBudget(`https://api.github.com${path}`, {
    method,
    headers: { ...GITHUB_HEADERS, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, { retries: 0 });
  const statusCode = res.status;
  const text = await res.text();
  let data: any;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (statusCode >= 400) throw new GitHubApiError({ code: `github_${statusCode}`, status: statusCode, message: data?.message || `HTTP ${statusCode}`, nextStep: 'Verify the App installation has write access (contents/pull_requests) to this repo and the branch/PR exists.' });
  return data as T;
}

const O = encodeURIComponent;

/** Read a file's decoded text + sha from a repo (helper for write workflows). */
export async function getFileContents(owner: string, repo: string, path: string, ref?: string): Promise<{ path: string; sha: string; text: string }> {
  const q = ref ? `?ref=${O(ref)}` : '';
  const d = await githubGet<any>(`/repos/${O(owner)}/${O(repo)}/contents/${path.split('/').map(O).join('/')}${q}`);
  return { path, sha: d.sha, text: d.content ? Buffer.from(d.content, 'base64').toString('utf8') : '' };
}

/**
 * Commit multiple files to a branch in ONE commit via the Git Data API.
 * Creates the branch from the repo's default branch if it doesn't exist.
 */
export async function pushFiles(
  owner: string, repo: string, branch: string,
  files: Array<{ path: string; content: string }>, message: string,
): Promise<{ commit: string; branch: string; files: number }> {
  const base = `/repos/${O(owner)}/${O(repo)}`;
  // Resolve branch head; create the branch from default if missing.
  let headSha: string;
  try {
    const ref = await githubGet<any>(`${base}/git/ref/heads/${O(branch)}`);
    headSha = ref.object.sha;
  } catch (e) {
    if (e instanceof GitHubApiError && e.status === 404) {
      const repoInfo = await githubGet<any>(base);
      const defRef = await githubGet<any>(`${base}/git/ref/heads/${O(repoInfo.default_branch)}`);
      headSha = defRef.object.sha;
      await githubSend('POST', `${base}/git/refs`, { ref: `refs/heads/${branch}`, sha: headSha });
    } else throw e;
  }
  const headCommit = await githubGet<any>(`${base}/git/commits/${headSha}`);
  const baseTree = headCommit.tree.sha;
  const blobs = await Promise.all(files.map(async (f) => {
    const b = await githubSend<any>('POST', `${base}/git/blobs`, { content: f.content, encoding: 'utf-8' });
    return { path: f.path, mode: '100644', type: 'blob', sha: b.sha };
  }));
  const tree = await githubSend<any>('POST', `${base}/git/trees`, { base_tree: baseTree, tree: blobs });
  const commit = await githubSend<any>('POST', `${base}/git/commits`, { message, tree: tree.sha, parents: [headSha] });
  await githubSend('PATCH', `${base}/git/refs/heads/${O(branch)}`, { sha: commit.sha, force: false });
  return { commit: commit.sha, branch, files: files.length };
}

/** True when the GitHub App path is usable (the same path every github_* tool already uses). */
export function isGithubAppConfigured(): boolean {
  return Boolean(env.GITHUB_APP_INSTALLATION_ID);
}

/** Fetch a commit. Used by the artifact resolver to verify gh:commit: URIs. */
export async function getCommit(owner: string, repo: string, sha: string): Promise<any> {
  return githubGet(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(sha)}`);
}

export async function getPullRequest(owner: string, repo: string, number: number): Promise<any> {
  return githubGet<any>(`/repos/${O(owner)}/${O(repo)}/pulls/${number}`);
}

export async function createIssueComment(owner: string, repo: string, number: number, body: string): Promise<void> {
  await githubSend('POST', `/repos/${O(owner)}/${O(repo)}/issues/${number}/comments`, { body });
}

export async function createPullRequest(
  owner: string, repo: string, title: string, head: string, base: string, body?: string, draft?: boolean,
): Promise<{ number: number; url: string; state: string }> {
  const pr = await githubSend<any>('POST', `/repos/${O(owner)}/${O(repo)}/pulls`, { title, head, base, body: body ?? '', draft: draft ?? false });
  return { number: pr.number, url: pr.html_url, state: pr.state };
}

export async function mergePullRequest(
  owner: string, repo: string, number: number, method: 'merge' | 'squash' | 'rebase' = 'squash', title?: string,
): Promise<{ merged: boolean; sha: string; message: string }> {
  const r = await githubSend<any>('PUT', `/repos/${O(owner)}/${O(repo)}/pulls/${number}/merge`, { merge_method: method, ...(title ? { commit_title: title } : {}) });
  return { merged: r.merged === true, sha: r.sha ?? '', message: r.message ?? '' };
}
