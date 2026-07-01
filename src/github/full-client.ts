/**
 * GitHub full-client — exhaustive repo-scope read + write operations.
 *
 * Self-contained: auth (GitHub App JWT → installation token, cached until ~1 min
 * before expiry) is copied from api-client.ts / write-client.ts.  This file adds
 * NO new environment variables — it re-uses GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY,
 * GITHUB_APP_INSTALLATION_ID exactly as the existing clients do.
 *
 * Ring-safety: assertNotPhi() mirrors write-client.ts — every mutation rejects any
 * repo whose name starts with "medreview" or contains "phi" (case-insensitive).
 *
 * Scope boundary: repo-level only. NO org admin, billing, or secrets endpoints.
 */

import { createSign } from 'node:crypto';
import { loadEnv } from '../config/env.js';
import { fetchWithBudget } from '../util/fetch-budget.js';

const env = loadEnv();

// ── Error class ────────────────────────────────────────────────────────────────

export class GitHubFullError extends Error {
  readonly code: string;
  readonly status: number;
  readonly nextStep: string;

  constructor(a: { code: string; status: number; message: string; nextStep: string }) {
    super(a.message);
    this.name = 'GitHubFullError';
    this.code = a.code;
    this.status = a.status;
    this.nextStep = a.nextStep;
  }
}

// ── Ring-safety guard ──────────────────────────────────────────────────────────

export function assertNotPhi(repo: string): void {
  if (/^medreview/i.test(repo) || /phi/i.test(repo)) {
    throw new GitHubFullError({
      code: 'github_write_phi_rejected',
      status: 0,
      message: `Write to repo "${repo}" is blocked: medreview/PHI repositories are read-only via this gateway.`,
      nextStep: 'Use a non-PHI repository, or contact the CTO to authorise this operation outside the gateway.',
    });
  }
}

// ── JWT + installation token ───────────────────────────────────────────────────

function b64url(x: object): string {
  return Buffer.from(JSON.stringify(x)).toString('base64url');
}

function mintJwt(): string {
  const appId = env.GITHUB_APP_ID;
  const privateKey = env.GITHUB_APP_PRIVATE_KEY;
  if (!appId)
    throw new GitHubFullError({ code: 'github_not_configured', status: 0, message: 'GITHUB_APP_ID not set.', nextStep: 'Add GITHUB_APP_ID to the vault.' });
  if (!privateKey)
    throw new GitHubFullError({ code: 'github_not_configured', status: 0, message: 'GITHUB_APP_PRIVATE_KEY not set.', nextStep: 'Add GITHUB_APP_PRIVATE_KEY to the vault.' });
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
    throw new GitHubFullError({ code: 'github_not_configured', status: 0, message: 'GITHUB_APP_INSTALLATION_ID not set.', nextStep: 'Add GITHUB_APP_INSTALLATION_ID to the vault.' });

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
    throw new GitHubFullError({ code: `github_${statusCode}`, status: statusCode, message: data?.message || `HTTP ${statusCode}`, nextStep: 'Verify GitHub App credentials and installation ID.' });

  cachedToken = data.token as string;
  const expiresAt: string | undefined = data.expires_at;
  tokenExpiresAt = expiresAt ? new Date(expiresAt).getTime() : now + 55 * 60 * 1000;
  return cachedToken;
}

// ── Core HTTP helpers ──────────────────────────────────────────────────────────

const O = encodeURIComponent;

async function ghGet<T = any>(path: string): Promise<T> {
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
  if (statusCode >= 400)
    throw new GitHubFullError({ code: `github_${statusCode}`, status: statusCode, message: data?.message || `HTTP ${statusCode}`, nextStep: 'Verify GitHub App installation has read access to this repository.' });
  return data as T;
}

async function ghSend<T = any>(
  method: 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<{ statusCode: number; data: T }> {
  const token = await getInstallationToken();
  // Non-idempotent write (create/update/delete refs, tags, releases, labels, etc.):
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
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (statusCode >= 400)
    throw new GitHubFullError({ code: `github_${statusCode}`, status: statusCode, message: data?.message || `HTTP ${statusCode}`, nextStep: 'Verify the App installation has write access to this repo.' });
  return { statusCode, data: data as T };
}

// ════════════════════════════════════════════════════════════════════════════════
// REPOS
// ════════════════════════════════════════════════════════════════════════════════

/** GET /repos/{owner}/{repo} */
export async function repoGet(owner: string, repo: string): Promise<any> {
  return ghGet(`/repos/${O(owner)}/${O(repo)}`);
}

/** GET /orgs/{org}/repos */
export async function repoListForOrg(org: string, type = 'all', perPage = 30, page = 1): Promise<any[]> {
  const data = await ghGet<any[]>(`/orgs/${O(org)}/repos?type=${O(type)}&per_page=${perPage}&page=${page}`);
  return Array.isArray(data) ? data : [];
}

/** GET /users/{username}/repos */
export async function repoListForUser(username: string, type = 'all', perPage = 30, page = 1): Promise<any[]> {
  const data = await ghGet<any[]>(`/users/${O(username)}/repos?type=${O(type)}&per_page=${perPage}&page=${page}`);
  return Array.isArray(data) ? data : [];
}

/** GET /repos/{owner}/{repo}/branches */
export async function repoListBranches(owner: string, repo: string, perPage = 30, page = 1): Promise<any[]> {
  const data = await ghGet<any[]>(`/repos/${O(owner)}/${O(repo)}/branches?per_page=${perPage}&page=${page}`);
  return Array.isArray(data) ? data : [];
}

/** GET /repos/{owner}/{repo}/tags */
export async function repoListTags(owner: string, repo: string, perPage = 30, page = 1): Promise<any[]> {
  const data = await ghGet<any[]>(`/repos/${O(owner)}/${O(repo)}/tags?per_page=${perPage}&page=${page}`);
  return Array.isArray(data) ? data : [];
}

/** GET /repos/{owner}/{repo}/contributors */
export async function repoListContributors(owner: string, repo: string, perPage = 30, page = 1): Promise<any[]> {
  const data = await ghGet<any[]>(`/repos/${O(owner)}/${O(repo)}/contributors?per_page=${perPage}&page=${page}`);
  return Array.isArray(data) ? data : [];
}

/** GET /repos/{owner}/{repo}/languages */
export async function repoListLanguages(owner: string, repo: string): Promise<Record<string, number>> {
  return ghGet(`/repos/${O(owner)}/${O(repo)}/languages`);
}

// ════════════════════════════════════════════════════════════════════════════════
// COMMITS
// ════════════════════════════════════════════════════════════════════════════════

/** GET /repos/{owner}/{repo}/commits */
export async function commitList(owner: string, repo: string, sha?: string, path?: string, perPage = 20, page = 1): Promise<any[]> {
  const params = new URLSearchParams({ per_page: String(perPage), page: String(page) });
  if (sha) params.set('sha', sha);
  if (path) params.set('path', path);
  const data = await ghGet<any[]>(`/repos/${O(owner)}/${O(repo)}/commits?${params}`);
  return Array.isArray(data) ? data : [];
}

/** GET /repos/{owner}/{repo}/commits/{ref} */
export async function commitGet(owner: string, repo: string, ref: string): Promise<any> {
  return ghGet(`/repos/${O(owner)}/${O(repo)}/commits/${O(ref)}`);
}

/** GET /repos/{owner}/{repo}/compare/{base}...{head} */
export async function commitCompare(owner: string, repo: string, base: string, head: string): Promise<any> {
  return ghGet(`/repos/${O(owner)}/${O(repo)}/compare/${O(base)}...${O(head)}`);
}

// ════════════════════════════════════════════════════════════════════════════════
// CONTENTS
// ════════════════════════════════════════════════════════════════════════════════

/**
 * DELETE /repos/{owner}/{repo}/contents/{path}
 * Deletes a file.  sha of the blob to delete is required.
 */
export async function contentsDeleteFile(opts: {
  owner: string;
  repo: string;
  path: string;
  message: string;
  sha: string;
  branch?: string;
  author?: { name: string; email: string };
}): Promise<{ commit: string; path: string }> {
  assertNotPhi(opts.repo);
  const filePath = opts.path.split('/').map(O).join('/');
  const body: Record<string, unknown> = { message: opts.message, sha: opts.sha };
  if (opts.branch) body.branch = opts.branch;
  if (opts.author) body.author = opts.author;
  const { data: r } = await ghSend<any>('DELETE', `/repos/${O(opts.owner)}/${O(opts.repo)}/contents/${filePath}`, body);
  return { commit: r.commit?.sha ?? '', path: opts.path };
}

// ════════════════════════════════════════════════════════════════════════════════
// BRANCHES
// ════════════════════════════════════════════════════════════════════════════════

/** GET /repos/{owner}/{repo}/branches/{branch} */
export async function branchGet(owner: string, repo: string, branch: string): Promise<any> {
  return ghGet(`/repos/${O(owner)}/${O(repo)}/branches/${O(branch)}`);
}

/** GET /repos/{owner}/{repo}/branches/{branch}/protection */
export async function branchGetProtection(owner: string, repo: string, branch: string): Promise<any> {
  return ghGet(`/repos/${O(owner)}/${O(repo)}/branches/${O(branch)}/protection`);
}

// ════════════════════════════════════════════════════════════════════════════════
// GIT REFS
// ════════════════════════════════════════════════════════════════════════════════

/** POST /repos/{owner}/{repo}/git/refs — create a ref */
export async function refCreate(owner: string, repo: string, ref: string, sha: string): Promise<any> {
  assertNotPhi(repo);
  const { data } = await ghSend<any>('POST', `/repos/${O(owner)}/${O(repo)}/git/refs`, { ref, sha });
  return data;
}

/** PATCH /repos/{owner}/{repo}/git/refs/{ref} — update (fast-forward or force) */
export async function refUpdate(owner: string, repo: string, ref: string, sha: string, force = false): Promise<any> {
  assertNotPhi(repo);
  const { data } = await ghSend<any>('PATCH', `/repos/${O(owner)}/${O(repo)}/git/refs/${ref}`, { sha, force });
  return data;
}

/** DELETE /repos/{owner}/{repo}/git/refs/{ref} */
export async function refDelete(owner: string, repo: string, ref: string): Promise<void> {
  assertNotPhi(repo);
  await ghSend<void>('DELETE', `/repos/${O(owner)}/${O(repo)}/git/refs/${ref}`);
}

// ════════════════════════════════════════════════════════════════════════════════
// GIT TAGS (annotated tag objects)
// ════════════════════════════════════════════════════════════════════════════════

/**
 * POST /repos/{owner}/{repo}/git/tags — create an annotated tag object.
 * After creation you may also create a ref (refs/tags/...) pointing to the tag SHA.
 */
export async function gitTagCreate(opts: {
  owner: string;
  repo: string;
  tag: string;
  message: string;
  object: string;   // SHA of commit / blob / tree
  type?: 'commit' | 'blob' | 'tree';
  tagger?: { name: string; email: string; date?: string };
}): Promise<{ tagSha: string; tag: string }> {
  assertNotPhi(opts.repo);
  const body: Record<string, unknown> = {
    tag: opts.tag,
    message: opts.message,
    object: opts.object,
    type: opts.type ?? 'commit',
  };
  if (opts.tagger) body.tagger = opts.tagger;
  const { data: r } = await ghSend<any>('POST', `/repos/${O(opts.owner)}/${O(opts.repo)}/git/tags`, body);
  return { tagSha: r.sha, tag: r.tag };
}

// ════════════════════════════════════════════════════════════════════════════════
// PULL REQUESTS (extended)
// ════════════════════════════════════════════════════════════════════════════════

/** GET /repos/{owner}/{repo}/pulls/{pull_number} */
export async function prGet(owner: string, repo: string, pullNumber: number): Promise<any> {
  return ghGet(`/repos/${O(owner)}/${O(repo)}/pulls/${pullNumber}`);
}

/** PATCH /repos/{owner}/{repo}/pulls/{pull_number} — update title/body/state/base */
export async function prUpdate(opts: {
  owner: string;
  repo: string;
  pullNumber: number;
  title?: string;
  body?: string;
  state?: 'open' | 'closed';
  base?: string;
  maintainerCanModify?: boolean;
}): Promise<any> {
  assertNotPhi(opts.repo);
  const body: Record<string, unknown> = {};
  if (opts.title !== undefined) body.title = opts.title;
  if (opts.body !== undefined) body.body = opts.body;
  if (opts.state !== undefined) body.state = opts.state;
  if (opts.base !== undefined) body.base = opts.base;
  if (opts.maintainerCanModify !== undefined) body.maintainer_can_modify = opts.maintainerCanModify;
  const { data } = await ghSend<any>('PATCH', `/repos/${O(opts.owner)}/${O(opts.repo)}/pulls/${opts.pullNumber}`, body);
  return data;
}

/** GET /repos/{owner}/{repo}/pulls/{pull_number}/files */
export async function prListFiles(owner: string, repo: string, pullNumber: number, perPage = 30, page = 1): Promise<any[]> {
  const data = await ghGet<any[]>(`/repos/${O(owner)}/${O(repo)}/pulls/${pullNumber}/files?per_page=${perPage}&page=${page}`);
  return Array.isArray(data) ? data : [];
}

/** GET /repos/{owner}/{repo}/pulls/{pull_number}/commits */
export async function prListCommits(owner: string, repo: string, pullNumber: number, perPage = 30, page = 1): Promise<any[]> {
  const data = await ghGet<any[]>(`/repos/${O(owner)}/${O(repo)}/pulls/${pullNumber}/commits?per_page=${perPage}&page=${page}`);
  return Array.isArray(data) ? data : [];
}

/** GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews */
export async function prListReviews(owner: string, repo: string, pullNumber: number): Promise<any[]> {
  const data = await ghGet<any[]>(`/repos/${O(owner)}/${O(repo)}/pulls/${pullNumber}/reviews`);
  return Array.isArray(data) ? data : [];
}

/** POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews — submit a review */
export async function prCreateReview(opts: {
  owner: string;
  repo: string;
  pullNumber: number;
  commitId?: string;
  body?: string;
  event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT' | 'PENDING';
  comments?: Array<{ path: string; position?: number; line?: number; body: string }>;
}): Promise<{ id: number; state: string; body: string }> {
  assertNotPhi(opts.repo);
  const body: Record<string, unknown> = { event: opts.event };
  if (opts.commitId) body.commit_id = opts.commitId;
  if (opts.body) body.body = opts.body;
  if (opts.comments) body.comments = opts.comments;
  const { data: r } = await ghSend<any>('POST', `/repos/${O(opts.owner)}/${O(opts.repo)}/pulls/${opts.pullNumber}/reviews`, body);
  return { id: r.id, state: r.state, body: r.body ?? '' };
}

/** POST /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers */
export async function prRequestReviewers(opts: {
  owner: string;
  repo: string;
  pullNumber: number;
  reviewers?: string[];
  teamReviewers?: string[];
}): Promise<any> {
  assertNotPhi(opts.repo);
  const body: Record<string, unknown> = {};
  if (opts.reviewers) body.reviewers = opts.reviewers;
  if (opts.teamReviewers) body.team_reviewers = opts.teamReviewers;
  const { data } = await ghSend<any>('POST', `/repos/${O(opts.owner)}/${O(opts.repo)}/pulls/${opts.pullNumber}/requested_reviewers`, body);
  return data;
}

/** PUT /repos/{owner}/{repo}/pulls/{pull_number}/update-branch */
export async function prUpdateBranch(owner: string, repo: string, pullNumber: number, expectedHeadSha?: string): Promise<{ message: string; url: string }> {
  assertNotPhi(repo);
  const body: Record<string, unknown> = {};
  if (expectedHeadSha) body.expected_head_sha = expectedHeadSha;
  const { data: r } = await ghSend<any>('PUT', `/repos/${O(owner)}/${O(repo)}/pulls/${pullNumber}/update-branch`, body);
  return { message: r.message ?? '', url: r.url ?? '' };
}

// ════════════════════════════════════════════════════════════════════════════════
// ISSUES (extended)
// ════════════════════════════════════════════════════════════════════════════════

/** GET /repos/{owner}/{repo}/issues/{issue_number} */
export async function issueGet(owner: string, repo: string, issueNumber: number): Promise<any> {
  return ghGet(`/repos/${O(owner)}/${O(repo)}/issues/${issueNumber}`);
}

/** PATCH /repos/{owner}/{repo}/issues/{issue_number} — update or close */
export async function issueUpdate(opts: {
  owner: string;
  repo: string;
  issueNumber: number;
  title?: string;
  body?: string;
  state?: 'open' | 'closed';
  stateReason?: 'completed' | 'not_planned' | 'reopened';
  labels?: string[];
  assignees?: string[];
  milestone?: number | null;
}): Promise<any> {
  assertNotPhi(opts.repo);
  const body: Record<string, unknown> = {};
  if (opts.title !== undefined) body.title = opts.title;
  if (opts.body !== undefined) body.body = opts.body;
  if (opts.state !== undefined) body.state = opts.state;
  if (opts.stateReason !== undefined) body.state_reason = opts.stateReason;
  if (opts.labels !== undefined) body.labels = opts.labels;
  if (opts.assignees !== undefined) body.assignees = opts.assignees;
  if (opts.milestone !== undefined) body.milestone = opts.milestone;
  const { data } = await ghSend<any>('PATCH', `/repos/${O(opts.owner)}/${O(opts.repo)}/issues/${opts.issueNumber}`, body);
  return data;
}

/** GET /repos/{owner}/{repo}/issues */
export async function issueList(owner: string, repo: string, state = 'open', labels?: string, perPage = 20, page = 1): Promise<any[]> {
  const params = new URLSearchParams({ state, per_page: String(perPage), page: String(page) });
  if (labels) params.set('labels', labels);
  const data = await ghGet<any[]>(`/repos/${O(owner)}/${O(repo)}/issues?${params}`);
  return Array.isArray(data) ? data : [];
}

/** GET /repos/{owner}/{repo}/issues/{issue_number}/comments */
export async function issueListComments(owner: string, repo: string, issueNumber: number, perPage = 30, page = 1): Promise<any[]> {
  const data = await ghGet<any[]>(`/repos/${O(owner)}/${O(repo)}/issues/${issueNumber}/comments?per_page=${perPage}&page=${page}`);
  return Array.isArray(data) ? data : [];
}

/** PUT /repos/{owner}/{repo}/issues/{issue_number}/lock */
export async function issueLock(owner: string, repo: string, issueNumber: number, lockReason?: 'off-topic' | 'too heated' | 'resolved' | 'spam'): Promise<void> {
  assertNotPhi(repo);
  const body: Record<string, unknown> = {};
  if (lockReason) body.lock_reason = lockReason;
  await ghSend<void>('PUT', `/repos/${O(owner)}/${O(repo)}/issues/${issueNumber}/lock`, body);
}

/** DELETE /repos/{owner}/{repo}/issues/{issue_number}/lock */
export async function issueUnlock(owner: string, repo: string, issueNumber: number): Promise<void> {
  assertNotPhi(repo);
  await ghSend<void>('DELETE', `/repos/${O(owner)}/${O(repo)}/issues/${issueNumber}/lock`);
}

/** POST /repos/{owner}/{repo}/issues/{issue_number}/assignees */
export async function issueAddAssignees(owner: string, repo: string, issueNumber: number, assignees: string[]): Promise<any> {
  assertNotPhi(repo);
  const { data } = await ghSend<any>('POST', `/repos/${O(owner)}/${O(repo)}/issues/${issueNumber}/assignees`, { assignees });
  return data;
}

// ════════════════════════════════════════════════════════════════════════════════
// LABELS
// ════════════════════════════════════════════════════════════════════════════════

/** GET /repos/{owner}/{repo}/labels */
export async function labelList(owner: string, repo: string, perPage = 30, page = 1): Promise<any[]> {
  const data = await ghGet<any[]>(`/repos/${O(owner)}/${O(repo)}/labels?per_page=${perPage}&page=${page}`);
  return Array.isArray(data) ? data : [];
}

/** POST /repos/{owner}/{repo}/labels */
export async function labelCreate(owner: string, repo: string, name: string, color: string, description?: string): Promise<any> {
  assertNotPhi(repo);
  const body: Record<string, unknown> = { name, color: color.replace('#', '') };
  if (description) body.description = description;
  const { data } = await ghSend<any>('POST', `/repos/${O(owner)}/${O(repo)}/labels`, body);
  return data;
}

/** PATCH /repos/{owner}/{repo}/labels/{name} */
export async function labelUpdate(owner: string, repo: string, labelName: string, opts: { name?: string; color?: string; description?: string }): Promise<any> {
  assertNotPhi(repo);
  const body: Record<string, unknown> = {};
  if (opts.name) body.name = opts.name;
  if (opts.color) body.color = opts.color.replace('#', '');
  if (opts.description !== undefined) body.description = opts.description;
  const { data } = await ghSend<any>('PATCH', `/repos/${O(owner)}/${O(repo)}/labels/${O(labelName)}`, body);
  return data;
}

/** DELETE /repos/{owner}/{repo}/labels/{name} */
export async function labelDelete(owner: string, repo: string, labelName: string): Promise<void> {
  assertNotPhi(repo);
  await ghSend<void>('DELETE', `/repos/${O(owner)}/${O(repo)}/labels/${O(labelName)}`);
}

// ════════════════════════════════════════════════════════════════════════════════
// MILESTONES
// ════════════════════════════════════════════════════════════════════════════════

/** GET /repos/{owner}/{repo}/milestones */
export async function milestoneList(owner: string, repo: string, state = 'open', perPage = 30, page = 1): Promise<any[]> {
  const data = await ghGet<any[]>(`/repos/${O(owner)}/${O(repo)}/milestones?state=${O(state)}&per_page=${perPage}&page=${page}`);
  return Array.isArray(data) ? data : [];
}

/** GET /repos/{owner}/{repo}/milestones/{milestone_number} */
export async function milestoneGet(owner: string, repo: string, milestoneNumber: number): Promise<any> {
  return ghGet(`/repos/${O(owner)}/${O(repo)}/milestones/${milestoneNumber}`);
}

/** POST /repos/{owner}/{repo}/milestones */
export async function milestoneCreate(owner: string, repo: string, title: string, opts?: { description?: string; dueOn?: string; state?: 'open' | 'closed' }): Promise<any> {
  assertNotPhi(repo);
  const body: Record<string, unknown> = { title };
  if (opts?.description) body.description = opts.description;
  if (opts?.dueOn) body.due_on = opts.dueOn;
  if (opts?.state) body.state = opts.state;
  const { data } = await ghSend<any>('POST', `/repos/${O(owner)}/${O(repo)}/milestones`, body);
  return data;
}

/** PATCH /repos/{owner}/{repo}/milestones/{milestone_number} */
export async function milestoneUpdate(owner: string, repo: string, milestoneNumber: number, opts: { title?: string; description?: string; dueOn?: string; state?: 'open' | 'closed' }): Promise<any> {
  assertNotPhi(repo);
  const body: Record<string, unknown> = {};
  if (opts.title) body.title = opts.title;
  if (opts.description !== undefined) body.description = opts.description;
  if (opts.dueOn !== undefined) body.due_on = opts.dueOn;
  if (opts.state) body.state = opts.state;
  const { data } = await ghSend<any>('PATCH', `/repos/${O(owner)}/${O(repo)}/milestones/${milestoneNumber}`, body);
  return data;
}

/** DELETE /repos/{owner}/{repo}/milestones/{milestone_number} */
export async function milestoneDelete(owner: string, repo: string, milestoneNumber: number): Promise<void> {
  assertNotPhi(repo);
  await ghSend<void>('DELETE', `/repos/${O(owner)}/${O(repo)}/milestones/${milestoneNumber}`);
}

// ════════════════════════════════════════════════════════════════════════════════
// RELEASES (extended)
// ════════════════════════════════════════════════════════════════════════════════

/** GET /repos/{owner}/{repo}/releases */
export async function releaseList(owner: string, repo: string, perPage = 20, page = 1): Promise<any[]> {
  const data = await ghGet<any[]>(`/repos/${O(owner)}/${O(repo)}/releases?per_page=${perPage}&page=${page}`);
  return Array.isArray(data) ? data : [];
}

/** GET /repos/{owner}/{repo}/releases/{release_id} */
export async function releaseGet(owner: string, repo: string, releaseId: number): Promise<any> {
  return ghGet(`/repos/${O(owner)}/${O(repo)}/releases/${releaseId}`);
}

/** GET /repos/{owner}/{repo}/releases/latest */
export async function releaseGetLatest(owner: string, repo: string): Promise<any> {
  return ghGet(`/repos/${O(owner)}/${O(repo)}/releases/latest`);
}

/** PATCH /repos/{owner}/{repo}/releases/{release_id} */
export async function releaseUpdate(owner: string, repo: string, releaseId: number, opts: {
  tagName?: string;
  name?: string;
  body?: string;
  draft?: boolean;
  prerelease?: boolean;
  makeLatest?: 'true' | 'false' | 'legacy';
}): Promise<any> {
  assertNotPhi(repo);
  const body: Record<string, unknown> = {};
  if (opts.tagName !== undefined) body.tag_name = opts.tagName;
  if (opts.name !== undefined) body.name = opts.name;
  if (opts.body !== undefined) body.body = opts.body;
  if (opts.draft !== undefined) body.draft = opts.draft;
  if (opts.prerelease !== undefined) body.prerelease = opts.prerelease;
  if (opts.makeLatest !== undefined) body.make_latest = opts.makeLatest;
  const { data } = await ghSend<any>('PATCH', `/repos/${O(owner)}/${O(repo)}/releases/${releaseId}`, body);
  return data;
}

/** DELETE /repos/{owner}/{repo}/releases/{release_id} */
export async function releaseDelete(owner: string, repo: string, releaseId: number): Promise<void> {
  assertNotPhi(repo);
  await ghSend<void>('DELETE', `/repos/${O(owner)}/${O(repo)}/releases/${releaseId}`);
}

/**
 * POST /repos/{owner}/{repo}/releases/generate-notes — generate release notes markdown.
 * Returns the generated notes; caller can use the body in a subsequent createRelease.
 */
export async function releaseGenerateNotes(owner: string, repo: string, tagName: string, opts?: { targetCommitish?: string; previousTagName?: string; configurationFilePath?: string }): Promise<{ name: string; body: string }> {
  const body: Record<string, unknown> = { tag_name: tagName };
  if (opts?.targetCommitish) body.target_commitish = opts.targetCommitish;
  if (opts?.previousTagName) body.previous_tag_name = opts.previousTagName;
  if (opts?.configurationFilePath) body.configuration_file_path = opts.configurationFilePath;
  const { data } = await ghSend<any>('POST', `/repos/${O(owner)}/${O(repo)}/releases/generate-notes`, body);
  return { name: data.name ?? tagName, body: data.body ?? '' };
}

// ════════════════════════════════════════════════════════════════════════════════
// WORKFLOWS (extended)
// ════════════════════════════════════════════════════════════════════════════════

/** GET /repos/{owner}/{repo}/actions/workflows */
export async function workflowList(owner: string, repo: string, perPage = 30, page = 1): Promise<any[]> {
  const data = await ghGet<{ workflows: any[] }>(`/repos/${O(owner)}/${O(repo)}/actions/workflows?per_page=${perPage}&page=${page}`);
  return Array.isArray(data?.workflows) ? data.workflows : [];
}

/** GET /repos/{owner}/{repo}/actions/workflows/{workflow_id} */
export async function workflowGet(owner: string, repo: string, workflowId: string | number): Promise<any> {
  return ghGet(`/repos/${O(owner)}/${O(repo)}/actions/workflows/${O(String(workflowId))}`);
}

/** PUT /repos/{owner}/{repo}/actions/workflows/{workflow_id}/enable */
export async function workflowEnable(owner: string, repo: string, workflowId: string | number): Promise<void> {
  assertNotPhi(repo);
  await ghSend<void>('PUT', `/repos/${O(owner)}/${O(repo)}/actions/workflows/${O(String(workflowId))}/enable`);
}

/** PUT /repos/{owner}/{repo}/actions/workflows/{workflow_id}/disable */
export async function workflowDisable(owner: string, repo: string, workflowId: string | number): Promise<void> {
  assertNotPhi(repo);
  await ghSend<void>('PUT', `/repos/${O(owner)}/${O(repo)}/actions/workflows/${O(String(workflowId))}/disable`);
}

// ════════════════════════════════════════════════════════════════════════════════
// WORKFLOW RUNS (extended)
// ════════════════════════════════════════════════════════════════════════════════

/** GET /repos/{owner}/{repo}/actions/runs/{run_id} */
export async function workflowRunGet(owner: string, repo: string, runId: number): Promise<any> {
  return ghGet(`/repos/${O(owner)}/${O(repo)}/actions/runs/${runId}`);
}

/** GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs */
export async function workflowRunListJobs(owner: string, repo: string, runId: number, filter: 'latest' | 'all' = 'latest'): Promise<any[]> {
  const data = await ghGet<{ jobs: any[] }>(`/repos/${O(owner)}/${O(repo)}/actions/runs/${runId}/jobs?filter=${filter}`);
  return Array.isArray(data?.jobs) ? data.jobs : [];
}

/** GET /repos/{owner}/{repo}/actions/runs/{run_id}/artifacts */
export async function workflowRunListArtifacts(owner: string, repo: string, runId: number): Promise<any[]> {
  const data = await ghGet<{ artifacts: any[] }>(`/repos/${O(owner)}/${O(repo)}/actions/runs/${runId}/artifacts`);
  return Array.isArray(data?.artifacts) ? data.artifacts : [];
}

/** POST /repos/{owner}/{repo}/actions/runs/{run_id}/cancel */
export async function workflowRunCancel(owner: string, repo: string, runId: number): Promise<void> {
  assertNotPhi(repo);
  await ghSend<void>('POST', `/repos/${O(owner)}/${O(repo)}/actions/runs/${runId}/cancel`);
}

/** POST /repos/{owner}/{repo}/actions/runs/{run_id}/rerun */
export async function workflowRunRerun(owner: string, repo: string, runId: number, enableDebugLogging = false): Promise<void> {
  assertNotPhi(repo);
  await ghSend<void>('POST', `/repos/${O(owner)}/${O(repo)}/actions/runs/${runId}/rerun`, { enable_debug_logging: enableDebugLogging });
}
