import { request } from 'undici';
import { createSign } from 'node:crypto';
import { loadEnv } from '../config/env.js';

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
  const { statusCode, body } = await request(url, {
    method: 'POST',
    headers: { ...GITHUB_HEADERS, Authorization: `Bearer ${jwt}` },
  });
  const text = await body.text();
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
  const { statusCode, body } = await request(`https://api.github.com${path}`, {
    method: 'GET',
    headers: { ...GITHUB_HEADERS, Authorization: `Bearer ${token}` },
  });
  const text = await body.text();
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
