/**
 * GitHub write-client — CTO-gated write operations via the App installation token.
 *
 * Auth is identical to api-client.ts (GitHub App JWT → installation access token,
 * cached until ~1 min before expiry). This file is intentionally self-contained so
 * the read client is never modified.
 *
 * Ring-safety: all functions reject any write targeting a repo whose name starts with
 * "medreview" or that is otherwise tagged as a PHI project, mirroring the carve
 * applied to Sentry/PostHog in the read clients.
 */

import { createSign } from 'node:crypto';
import { loadEnv } from '../config/env.js';
import { fetchWithBudget } from '../util/fetch-budget.js';
import { planStrEdit, assertShaMatch, makeEditPreview } from './edit-core.js';

const env = loadEnv();

// ── Error class (mirrors GitHubApiError shape) ───────────────────────────────

export class GitHubWriteError extends Error {
  readonly code: string;
  readonly status: number;
  readonly nextStep: string;

  constructor(a: { code: string; status: number; message: string; nextStep: string }) {
    super(a.message);
    this.name = 'GitHubWriteError';
    this.code = a.code;
    this.status = a.status;
    this.nextStep = a.nextStep;
  }
}

// ── Ring-safety guard ─────────────────────────────────────────────────────────

function assertNotPhi(repo: string): void {
  if (/^medreview/i.test(repo) || /phi/i.test(repo)) {
    throw new GitHubWriteError({
      code: 'github_write_phi_rejected',
      status: 0,
      message: `Write to repo "${repo}" is blocked: medreview/PHI repositories are read-only via this gateway.`,
      nextStep: 'Use a non-PHI repository, or contact the CTO to authorise this operation outside the gateway.',
    });
  }
}

// ── JWT + installation token (self-contained copy) ────────────────────────────

function b64url(x: object): string {
  return Buffer.from(JSON.stringify(x)).toString('base64url');
}

function mintJwt(): string {
  const appId = env.GITHUB_APP_ID;
  const privateKey = env.GITHUB_APP_PRIVATE_KEY;
  if (!appId)
    throw new GitHubWriteError({
      code: 'github_not_configured',
      status: 0,
      message: 'GITHUB_APP_ID not set.',
      nextStep: 'Add GITHUB_APP_ID to the vault.',
    });
  if (!privateKey)
    throw new GitHubWriteError({
      code: 'github_not_configured',
      status: 0,
      message: 'GITHUB_APP_PRIVATE_KEY not set.',
      nextStep: 'Add GITHUB_APP_PRIVATE_KEY to the vault.',
    });
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

let cachedToken: string | null = null;
let tokenExpiresAt = 0;

async function getInstallationToken(): Promise<string> {
  const now = Date.now();
  if (cachedToken && now < tokenExpiresAt - 60_000) return cachedToken;

  const installationId = env.GITHUB_APP_INSTALLATION_ID;
  if (!installationId)
    throw new GitHubWriteError({
      code: 'github_not_configured',
      status: 0,
      message: 'GITHUB_APP_INSTALLATION_ID not set.',
      nextStep: 'Add GITHUB_APP_INSTALLATION_ID to the vault.',
    });

  const jwt = mintJwt();
  const url = `https://api.github.com/app/installations/${encodeURIComponent(installationId)}/access_tokens`;
  // Token mint: retries:0 (a duplicate mint is wasted, not harmful, but be conservative).
  const res = await fetchWithBudget(url, {
    method: 'POST',
    headers: { ...GITHUB_HEADERS, Authorization: `Bearer ${jwt}` },
  }, { retries: 0 });
  const statusCode = res.status;
  const text = await res.text();
  let data: any;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (statusCode >= 400)
    throw new GitHubWriteError({
      code: `github_${statusCode}`,
      status: statusCode,
      message: data?.message || `HTTP ${statusCode}`,
      nextStep: 'Verify GitHub App credentials and installation ID.',
    });

  cachedToken = data.token as string;
  const expiresAt: string | undefined = data.expires_at;
  tokenExpiresAt = expiresAt ? new Date(expiresAt).getTime() : now + 55 * 60 * 1000;
  return cachedToken;
}

// ── Core HTTP helpers ─────────────────────────────────────────────────────────

async function ghSend<T = any>(
  method: 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<T> {
  const token = await getInstallationToken();
  // Non-idempotent write (create branch/file/issue/release, dispatch a workflow, etc.):
  // retries:0 so a timeout never causes a duplicate GitHub mutation.
  const res = await fetchWithBudget(`https://api.github.com${path}`, {
    method,
    headers: {
      ...GITHUB_HEADERS,
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  }, { retries: 0 });
  const statusCode = res.status;
  const text = await res.text();
  let data: any;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (statusCode >= 400)
    throw new GitHubWriteError({
      code: `github_${statusCode}`,
      status: statusCode,
      message: data?.message || `HTTP ${statusCode}`,
      nextStep: 'Verify the App installation has write access (contents/issues/workflows) to this repo.',
    });
  return data as T;
}

async function ghGet<T = any>(path: string): Promise<T> {
  const token = await getInstallationToken();
  // Read-only GET (used here to resolve a branch head / repo default branch before a
  // write): safe to retry once on a network blip / 429 / 5xx.
  const res = await fetchWithBudget(`https://api.github.com${path}`, {
    method: 'GET',
    headers: { ...GITHUB_HEADERS, Authorization: `Bearer ${token}` },
  }, { retries: 1 });
  const statusCode = res.status;
  const text = await res.text();
  let data: any;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (statusCode >= 400)
    throw new GitHubWriteError({
      code: `github_${statusCode}`,
      status: statusCode,
      message: data?.message || `HTTP ${statusCode}`,
      nextStep: 'Verify GitHub App installation has read access to this repository.',
    });
  return data as T;
}

const O = encodeURIComponent;

// ── Write operations ──────────────────────────────────────────────────────────

/**
 * Create a branch from `sha` (defaults to the repo's default-branch HEAD).
 * Returns the newly created ref name and the commit SHA it points to.
 */
export async function createBranch(
  owner: string,
  repo: string,
  branch: string,
  fromSha?: string,
): Promise<{ branch: string; sha: string }> {
  assertNotPhi(repo);
  const base = `/repos/${O(owner)}/${O(repo)}`;

  let sha = fromSha;
  if (!sha) {
    const repoInfo = await ghGet<any>(base);
    const defRef = await ghGet<any>(`${base}/git/ref/heads/${O(repoInfo.default_branch)}`);
    sha = defRef.object.sha as string;
  }

  await ghSend('POST', `${base}/git/refs`, { ref: `refs/heads/${branch}`, sha });
  return { branch, sha };
}

/**
 * Create or update a single file in a repo (PUT /repos/{o}/{r}/contents/{path}).
 * `sha` is required when updating an existing file; omit for new files.
 */
export async function createOrUpdateFile(opts: {
  owner: string;
  repo: string;
  path: string;
  message: string;
  content: string;        // UTF-8 text; will be base64-encoded for the API
  branch?: string;
  sha?: string;           // Required to UPDATE an existing file
  author?: { name: string; email: string };
}): Promise<{ commit: string; path: string; operation: 'created' | 'updated' }> {
  assertNotPhi(opts.repo);
  const base64Content = Buffer.from(opts.content, 'utf-8').toString('base64');
  const body: Record<string, unknown> = {
    message: opts.message,
    content: base64Content,
  };
  if (opts.branch) body.branch = opts.branch;
  if (opts.sha) body.sha = opts.sha;
  if (opts.author) body.author = opts.author;

  const filePath = opts.path.split('/').map(O).join('/');
  const r = await ghSend<any>('PUT', `/repos/${O(opts.owner)}/${O(opts.repo)}/contents/${filePath}`, body);
  return {
    commit: r.commit?.sha ?? '',
    path: opts.path,
    operation: opts.sha ? 'updated' : 'created',
  };
}

/**
 * editFile — surgical in-place edit. Reads the file, replaces old_str with new_str, writes it back.
 *
 * WHY THIS EXISTS: every other write path on this gateway demands FULL FILE CONTENT. That made a
 * 2-line change to a 65KB production file (skills/doc-indexer/indexer.mjs) unlandable from the Claude
 * Chat CTO seat -- you cannot safely retype 65KB through a chat channel. A half-widened capability
 * surface just moves the wall. This removes the wall.
 *
 * SAFETY MODEL: old_str MUST match exactly once unless replace_all is set (see planStrEdit). An
 * ambiguous patch FAILS LOUD; it never guesses which occurrence you meant. Honors expected_sha
 * (optimistic concurrency) and dry_run (returns a diff preview, writes nothing).
 */
export async function editFile(opts: {
  owner: string;
  repo: string;
  path: string;
  message: string;
  old_str: string;
  new_str: string;
  branch?: string;
  expected_sha?: string;
  replace_all?: boolean;
  dry_run?: boolean;
}): Promise<{
  executed: boolean;
  dry_run: boolean;
  path: string;
  replacements: number;
  sha: string;
  commit?: string;
  preview?: string;
}> {
  assertNotPhi(opts.repo);
  // Lazy import: api-client.ts calls loadEnv() at module scope; a static top-level import here would
  // execute that at module-load time and take the test suite red. Import at call time (runtime only).
  const { getFileContents } = await import('./api-client.js');
  const cur = await getFileContents(opts.owner, opts.repo, opts.path, opts.branch);
  assertShaMatch(opts.path, cur.sha, opts.expected_sha);
  const { next, matches } = planStrEdit(cur.text, opts.old_str, opts.new_str, opts.replace_all);

  if (opts.dry_run) {
    return {
      executed: false,
      dry_run: true,
      path: opts.path,
      replacements: matches,
      sha: cur.sha,
      preview: makeEditPreview(cur.text, opts.old_str, opts.new_str),
    };
  }
  const r = await createOrUpdateFile({
    owner: opts.owner,
    repo: opts.repo,
    path: opts.path,
    message: opts.message,
    content: next,
    branch: opts.branch,
    sha: cur.sha,
  });
  return { executed: true, dry_run: false, path: opts.path, replacements: matches, sha: cur.sha, commit: r.commit };
}

/**
 * Create a new issue in a repository.
 */
export async function createIssue(opts: {
  owner: string;
  repo: string;
  title: string;
  body?: string;
  labels?: string[];
  assignees?: string[];
  milestone?: number;
}): Promise<{ number: number; url: string; state: string }> {
  assertNotPhi(opts.repo);
  const r = await ghSend<any>('POST', `/repos/${O(opts.owner)}/${O(opts.repo)}/issues`, {
    title: opts.title,
    body: opts.body ?? '',
    labels: opts.labels ?? [],
    assignees: opts.assignees ?? [],
    ...(opts.milestone !== undefined ? { milestone: opts.milestone } : {}),
  });
  return { number: r.number, url: r.html_url, state: r.state };
}

/**
 * Post a comment on an existing issue or pull request (they share the same
 * /issues/{number}/comments endpoint on GitHub).
 */
export async function commentOnIssue(
  owner: string,
  repo: string,
  issueNumber: number,
  body: string,
): Promise<{ id: number; url: string }> {
  assertNotPhi(repo);
  const r = await ghSend<any>(
    'POST',
    `/repos/${O(owner)}/${O(repo)}/issues/${issueNumber}/comments`,
    { body },
  );
  return { id: r.id, url: r.html_url };
}

/**
 * Add labels to an issue or pull request.
 * Returns the current set of labels on the issue after the operation.
 */
export async function addLabels(
  owner: string,
  repo: string,
  issueNumber: number,
  labels: string[],
): Promise<{ labels: string[] }> {
  assertNotPhi(repo);
  const r = await ghSend<any[]>(
    'POST',
    `/repos/${O(owner)}/${O(repo)}/issues/${issueNumber}/labels`,
    { labels },
  );
  return { labels: Array.isArray(r) ? r.map((l: any) => l.name as string) : [] };
}

/**
 * Create a release (tag + release notes).
 * If `generateReleaseNotes` is true, GitHub auto-generates the body from merged PRs.
 */
export async function createRelease(opts: {
  owner: string;
  repo: string;
  tagName: string;
  name?: string;
  body?: string;
  targetCommitish?: string;   // branch or SHA; defaults to repo default branch
  draft?: boolean;
  prerelease?: boolean;
  generateReleaseNotes?: boolean;
}): Promise<{ id: number; url: string; tagName: string; draft: boolean; prerelease: boolean }> {
  assertNotPhi(opts.repo);
  const r = await ghSend<any>('POST', `/repos/${O(opts.owner)}/${O(opts.repo)}/releases`, {
    tag_name: opts.tagName,
    name: opts.name ?? opts.tagName,
    body: opts.body ?? '',
    target_commitish: opts.targetCommitish,
    draft: opts.draft ?? false,
    prerelease: opts.prerelease ?? false,
    generate_release_notes: opts.generateReleaseNotes ?? false,
  });
  return {
    id: r.id,
    url: r.html_url,
    tagName: r.tag_name,
    draft: r.draft,
    prerelease: r.prerelease,
  };
}

/**
 * Dispatch a workflow_dispatch event for a workflow identified by its file name
 * or numeric ID (POST /repos/{o}/{r}/actions/workflows/{id}/dispatches).
 * `inputs` are optional workflow-dispatch input key/values.
 * Returns void on success (GitHub returns 204 No Content).
 */
export async function dispatchWorkflow(
  owner: string,
  repo: string,
  workflowId: string | number,
  ref: string,
  inputs?: Record<string, string>,
): Promise<{ dispatched: true; owner: string; repo: string; workflow: string | number; ref: string }> {
  assertNotPhi(repo);
  await ghSend<void>(
    'POST',
    `/repos/${O(owner)}/${O(repo)}/actions/workflows/${O(String(workflowId))}/dispatches`,
    { ref, inputs: inputs ?? {} },
  );
  return { dispatched: true, owner, repo, workflow: workflowId, ref };
}
