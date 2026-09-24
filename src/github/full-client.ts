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

import { createHash, createSign } from 'node:crypto';
import { TextDecoder } from 'node:util';
import { loadEnv } from '../config/env.js';
import { fetchWithBudget } from '../util/fetch-budget.js';
import type { PinnedObservationFailureStage } from '../audit/internal-diagnostics.js';
import {
  extractPinnedReceiptJson,
  MAX_GRAPHRAG_ARCHIVE_BYTES,
  parseStrictJson,
  PINNED_GRAPHRAG_OBSERVATION,
  validatePinnedObservationReceipt,
} from './graphrag-observation-receipt.js';

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

class PinnedObservationReaderError extends GitHubFullError {
  readonly internalDiagnostic: { type: 'github_observation_receipt'; stage: PinnedObservationFailureStage };

  constructor(stage: PinnedObservationFailureStage) {
    super(PINNED_OBSERVATION_ERROR);
    this.name = 'PinnedObservationReaderError';
    this.internalDiagnostic = { type: 'github_observation_receipt', stage };
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

const PINNED_OBSERVATION_API = 'https://api.github.com';
const PINNED_OBSERVATION_MAX_METADATA_BYTES = 128 * 1024;
const PINNED_OBSERVATION_MAX_TOKEN_RESPONSE_BYTES = 16 * 1024;
const PINNED_OBSERVATION_TIMEOUT_MS = 8000;
const PINNED_OBSERVATION_ERROR = {
  code: 'github_observation_receipt_unverified',
  status: 0,
  message: 'The pinned GraphRAG observation receipt could not be verified.',
  nextStep: 'Check GitHub access and the fixed run and artifact provenance, then retry.',
} as const;

let pinnedObservationCachedToken: string | null = null;
let pinnedObservationTokenExpiresAt = 0;

function requireRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('invalid metadata');
  return value as Record<string, unknown>;
}

function requireSafeInteger(value: unknown, min = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) throw new Error('invalid metadata');
  return value;
}

function requireString(value: unknown, expected?: string): string {
  if (typeof value !== 'string' || (expected !== undefined && value !== expected)) throw new Error('invalid metadata');
  return value;
}

async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // A body discard is best-effort and must not replace the fixed public error below.
  }
}

async function readBoundedResponseBytes(response: Response, maxBytes: number): Promise<Buffer> {
  const lengthHeader = response.headers.get('content-length');
  let declaredLength: number | undefined;
  if (lengthHeader !== null) {
    if (!/^(?:0|[1-9]\d*)$/.test(lengthHeader)) {
      await cancelResponseBody(response);
      throw new Error('invalid response length');
    }
    declaredLength = Number(lengthHeader);
    if (!Number.isSafeInteger(declaredLength) || declaredLength > maxBytes) {
      await cancelResponseBody(response);
      throw new Error('response too large');
    }
  }

  const reader = response.body?.getReader();
  if (!reader) throw new Error('missing response body');
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    void reader.cancel().catch(() => undefined);
  }, PINNED_OBSERVATION_TIMEOUT_MS);
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.byteLength > maxBytes - totalBytes) {
        try { await reader.cancel(); } catch { /* keep the bounded parse failure */ }
        throw new Error('response too large');
      }
      const chunk = Buffer.from(value);
      totalBytes += chunk.length;
      chunks.push(chunk);
    }
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
  }
  if (timedOut) throw new Error('response body timed out');
  return Buffer.concat(chunks, totalBytes);
}

async function getPinnedObservationInstallationToken(): Promise<string> {
  const now = Date.now();
  if (pinnedObservationCachedToken && now < pinnedObservationTokenExpiresAt - 60_000) {
    return pinnedObservationCachedToken;
  }

  const installationId = env.GITHUB_APP_INSTALLATION_ID;
  if (!installationId) throw new Error('GitHub installation is not configured');

  const tokenUrl = new URL(
    `/app/installations/${encodeURIComponent(installationId)}/access_tokens`,
    PINNED_OBSERVATION_API,
  );
  const response = await fetchWithBudget(tokenUrl, {
    method: 'POST',
    redirect: 'error',
    headers: {
      ...GITHUB_HEADERS,
      Authorization: `Bearer ${mintJwt()}`,
    },
  }, { retries: 0, timeoutMs: PINNED_OBSERVATION_TIMEOUT_MS });

  if (response.status !== 201) {
    await cancelResponseBody(response);
    throw new Error('GitHub installation token request failed');
  }

  const bytes = await readBoundedResponseBytes(response, PINNED_OBSERVATION_MAX_TOKEN_RESPONSE_BYTES);
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new Error('Invalid GitHub installation token response');
  }

  const tokenResponse = requireRecord(parseStrictJson(text, PINNED_OBSERVATION_MAX_TOKEN_RESPONSE_BYTES));
  const token = tokenResponse.token;
  const expiresAt = tokenResponse.expires_at;
  if (typeof token !== 'string' || token.length === 0 || token.length > 4096 ||
      token.trim() !== token || /[\u0000-\u001f\u007f]/.test(token) || typeof expiresAt !== 'string') {
    throw new Error('Invalid GitHub installation token response');
  }

  const expiresAtMs = Date.parse(expiresAt);
  const validatedAt = Date.now();
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= validatedAt) {
    throw new Error('Invalid GitHub installation token expiry');
  }

  pinnedObservationCachedToken = token;
  pinnedObservationTokenExpiresAt = Math.min(expiresAtMs, validatedAt + 55 * 60 * 1000);
  return token;
}

async function pinnedGitHubApiGetJson(path: string, token: string): Promise<unknown> {
  const url = new URL(path, PINNED_OBSERVATION_API);
  if (url.origin !== PINNED_OBSERVATION_API) throw new Error('invalid fixed GitHub API URL');
  const response = await fetchWithBudget(url, {
    method: 'GET',
    redirect: 'error',
    headers: { ...GITHUB_HEADERS, Authorization: `Bearer ${token}` },
  }, { retries: 0, timeoutMs: PINNED_OBSERVATION_TIMEOUT_MS });
  if (response.status !== 200) {
    await cancelResponseBody(response);
    throw new Error('GitHub API request failed');
  }
  const bytes = await readBoundedResponseBytes(response, PINNED_OBSERVATION_MAX_METADATA_BYTES);
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new Error('invalid GitHub API response');
  }
  return parseStrictJson(text, PINNED_OBSERVATION_MAX_METADATA_BYTES);
}

function verifyRepositoryMetadata(value: unknown): number {
  const repo = requireRecord(value);
  if (requireString(repo.full_name, PINNED_GRAPHRAG_OBSERVATION.repository) !== PINNED_GRAPHRAG_OBSERVATION.repository ||
      requireString(repo.name, PINNED_GRAPHRAG_OBSERVATION.repo) !== PINNED_GRAPHRAG_OBSERVATION.repo) throw new Error('repository mismatch');
  const owner = requireRecord(repo.owner);
  requireString(owner.login, PINNED_GRAPHRAG_OBSERVATION.owner);
  return requireSafeInteger(repo.id, 1);
}

function verifyRunMetadata(value: unknown, repositoryId: number): void {
  const run = requireRecord(value);
  if (requireSafeInteger(run.id, 1) !== PINNED_GRAPHRAG_OBSERVATION.runId ||
      requireString(run.name, PINNED_GRAPHRAG_OBSERVATION.workflowName) !== PINNED_GRAPHRAG_OBSERVATION.workflowName ||
      requireString(run.path, PINNED_GRAPHRAG_OBSERVATION.workflowPath) !== PINNED_GRAPHRAG_OBSERVATION.workflowPath ||
      requireString(run.event, 'workflow_dispatch') !== 'workflow_dispatch' ||
      requireString(run.status, 'completed') !== 'completed' ||
      requireString(run.conclusion, 'success') !== 'success' ||
      requireString(run.head_branch, 'main') !== 'main' ||
      requireString(run.head_sha, PINNED_GRAPHRAG_OBSERVATION.headSha) !== PINNED_GRAPHRAG_OBSERVATION.headSha) {
    throw new Error('run mismatch');
  }
  const sourceRepository = requireRecord(run.repository);
  const headRepository = requireRecord(run.head_repository);
  if (requireSafeInteger(sourceRepository.id, 1) !== repositoryId ||
      requireString(sourceRepository.full_name, PINNED_GRAPHRAG_OBSERVATION.repository) !== PINNED_GRAPHRAG_OBSERVATION.repository ||
      requireSafeInteger(headRepository.id, 1) !== repositoryId ||
      requireString(headRepository.full_name, PINNED_GRAPHRAG_OBSERVATION.repository) !== PINNED_GRAPHRAG_OBSERVATION.repository) {
    throw new Error('run repository mismatch');
  }
}

function verifyContentBlob(value: unknown, path: string, expectedSha: string): void {
  const content = requireRecord(value);
  if (requireString(content.type, 'file') !== 'file' || requireString(content.path, path) !== path ||
      requireString(content.sha, expectedSha) !== expectedSha) throw new Error('source provenance mismatch');
}

function verifyArtifactMetadata(value: unknown, repositoryId: number): { sizeBytes: number; expiresAt: number; digest: string | null } {
  const artifact = requireRecord(value);
  if (requireSafeInteger(artifact.id, 1) !== PINNED_GRAPHRAG_OBSERVATION.artifactId ||
      requireString(artifact.name, PINNED_GRAPHRAG_OBSERVATION.artifactName) !== PINNED_GRAPHRAG_OBSERVATION.artifactName ||
      artifact.expired !== false) throw new Error('artifact mismatch');
  const sizeBytes = requireSafeInteger(artifact.size_in_bytes, 1);
  if (sizeBytes > MAX_GRAPHRAG_ARCHIVE_BYTES) throw new Error('artifact too large');
  if (typeof artifact.expires_at !== 'string') throw new Error('artifact expiry missing');
  const expiresAt = Date.parse(artifact.expires_at);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) throw new Error('artifact expired');

  const workflowRun = requireRecord(artifact.workflow_run);
  if (requireSafeInteger(workflowRun.id, 1) !== PINNED_GRAPHRAG_OBSERVATION.runId ||
      requireSafeInteger(workflowRun.repository_id, 1) !== repositoryId ||
      requireSafeInteger(workflowRun.head_repository_id, 1) !== repositoryId ||
      requireString(workflowRun.head_branch, 'main') !== 'main' ||
      requireString(workflowRun.head_sha, PINNED_GRAPHRAG_OBSERVATION.headSha) !== PINNED_GRAPHRAG_OBSERVATION.headSha) {
    throw new Error('artifact provenance mismatch');
  }

  let digest: string | null = null;
  if (artifact.digest !== undefined && artifact.digest !== null) {
    if (typeof artifact.digest !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(artifact.digest)) throw new Error('invalid artifact digest');
    digest = artifact.digest.slice('sha256:'.length);
  }
  return { sizeBytes, expiresAt, digest };
}

// GitHub Actions uses a finite set of result-storage shards for signed artifact redirects.
const GITHUB_ACTIONS_ARTIFACT_STORAGE_HOSTS = new Set([
  'productionresultssa0.blob.core.windows.net',
  'productionresultssa1.blob.core.windows.net',
  'productionresultssa2.blob.core.windows.net',
  'productionresultssa3.blob.core.windows.net',
  'productionresultssa4.blob.core.windows.net',
  'productionresultssa5.blob.core.windows.net',
  'productionresultssa6.blob.core.windows.net',
  'productionresultssa7.blob.core.windows.net',
  'productionresultssa8.blob.core.windows.net',
  'productionresultssa9.blob.core.windows.net',
  'productionresultssa10.blob.core.windows.net',
  'productionresultssa11.blob.core.windows.net',
  'productionresultssa12.blob.core.windows.net',
  'productionresultssa13.blob.core.windows.net',
  'productionresultssa14.blob.core.windows.net',
  'productionresultssa15.blob.core.windows.net',
  'productionresultssa16.blob.core.windows.net',
  'productionresultssa17.blob.core.windows.net',
  'productionresultssa18.blob.core.windows.net',
  'productionresultssa19.blob.core.windows.net',
]);
const GITHUB_ACTIONS_ARTIFACT_STORAGE_PATH_PREFIX = '/actions-results/';

function validateSignedArtifactUrl(location: string | null): URL {
  if (!location) throw new Error('missing si…23728 tokens truncated…(COLD_START_MESSAGE);
        if (capturePressure?.nudge) capturePlanePrelude.push(buildCaptureNudgeMessage(capturePressure.mutations));
        // Composes with (does not replace) the cold_start/capture_pressure prelude lines above --
        // all three channel into the SAME capturePlanePrelude array/text block.
        if (jitDoctrine.pitfalls.length) {
          capturePlanePrelude.push(`DOCTRINE: ${jitDoctrine.pitfalls.join(' | ')}`);
        }
        let text = buildTextContent(
          { ...payload, data: result },
          warning,
          capturePlanePrelude.length ? capturePlanePrelude.join('\n') : undefined,
        );

        // JIT tool-payload retrieval: offload an oversized result to Cosmos and return a preview +
        // result_id instead of the full payload (agent pulls it on demand via gateway_fetch_result).
        // Fail-open: offloadResult returns null on any error, so we keep the full inline result.
        // Small results are untouched (backward-compatible).
        //
        // M365 EXCEPTION (2026-07-25): skip offloading entirely for M365 declarative-agent static-
        // token callers (isM365StaticAuth()). Confirmed via direct reproduction that M365 Copilot's
        // own tool-calling orchestrator does NOT reliably chain into gateway_fetch_result when it
        // sees the offload stub -- it reports "no content available" instead, even when
        // gateway_fetch_result is a declared, callable tool on that same agent (Matt hit this live on
        // wake(), whose payload is routinely >40KB). Other engines (Claude Code, Hyperagent) are
        // UNCHANGED -- they reliably use the two-hop pattern today, so this is scoped narrowly to the
        // one consumer confirmed not to support it, not a global behavior change.
        // The dedicated source may contain investor material. The shared result cache has no
        // caller binding, so this principal must keep its payload inline, never in that cache.
        // gateway_fetch_result is already the terminal, bounded pagination transport. Re-offloading
        // one of its pages creates an unusable result-id chain instead of delivering that page.
        if (
          mayOffloadToolResult(canonicalName) &&
          callerAgent !== WEFUNDER_CAMPAIGN_DIRECTOR_LANE &&
          shouldOffload(text) &&
          !isM365StaticAuth()
        ) {
          const off = await offloadResult(text, result, correlationId, callerHash);
          if (off) {
            text = off.preview;
            // Bounded inline summary (pagination.itemCount/pageCount, shim page counts, array
            // lengths) so a caller sizing a population never has to page to the tail (issue #291a).
            const summary = extractResultSummary(result);
            structured.result = {
              _jit_offloaded: true,
              result_id: off.resultId,
              total_bytes: off.totalBytes,
              ...(summary ? { summary } : {}),
              note: 'Full payload offloaded to keep context small; call gateway_fetch_result(result_id).',
            };
          }
        }

        return {
          content: [{ type: 'text', text }],
          structuredContent: structured,
        };
      } catch (err) {
        const e = err as Error;
        let errorCode = 'tool_error';
        let nextStep = 'Check server logs for the correlation_id.';
        let upstreamStatus: number | undefined;
        const upstreamErr = parseUpstreamToolError(err);
        if (upstreamErr) {
          errorCode = upstreamErr.code;
          nextStep = upstreamErr.nextStep;
          upstreamStatus = upstreamErr.status;
        }
        const errPayload: Record<string, unknown> = {
          code: errorCode,
          message: e.message,
          next_step: nextStep,
        };
        if (upstreamStatus !== undefined) errPayload.upstream_status = upstreamStatus;
        const internalDiagnostic = projectPinnedObservationDiagnostic(err, callerAgent, correlationId);
        if (internalDiagnostic) errPayload.internal_diagnostic = internalDiagnostic;
        logToolEnd({
          correlation_id: correlationId,
          tool: def.name,
          caller_hash: callerHash,
          outcome: 'error',
          latency_ms: Date.now() - started,
          error_code: errorCode,
          error_message: e.message,
        });
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `Tool ${def.name} failed: ${e.message}\nNext step: ${nextStep}\ncorrelation_id: ${correlationId}`,
            },
          ],
          structuredContent: {
            result: null,
            compliance_warning: null,
            correlation_id: correlationId,
            dry_run: dryRun,
            error: errPayload,
          },
        };
      }
    },
  );

  // M365 PREFIX-STRIP COMPAT SHIM (2026-07-26, WIDENED + HARDENED 2026-07-28): M365 Copilot's own
  // tool-calling orchestrator has been observed splitting a registered tool name on its first
  // underscore and calling only the remainder -- confirmed precedent in memory/recall-alias.ts
  // (2026-07-25: "memory_recall" -> "recall"), then "github_repo_get" -> "repo_get" and
  // "depot_run_list" -> "run_list" (2026-07-26). Originally scoped to just the github_/depot_
  // prefixes. WIDENED 2026-07-28 after a live Developer-agent diagnostic run (Matt, in production
  // M365 Copilot) hit the SAME failure on "catalog_probe" -> "probe" and "developer_wake_lite" ->
  // "wake_lite" -- proving the behavior is generic to ANY underscored tool name.
  //
  // THIS BLOCK ONLY COLLECTS CANDIDATES -- it never registers an alias directly. See
  // finalizeM365Aliases() above for why (a single-pass "first tool through wins" policy was found,
  // in review, to be able to SILENTLY MIS-ROUTE a call to the wrong tool's handler when 3+ tools
  // collide on the same stripped name, e.g. n8n_workflow_get / github_workflow_get /
  // depot_workflow_get all -> "workflow_get" -- not merely leave the loser unreachable). Every
  // primary (non-alias) registration is also tracked in primaryNamesFor() UNCONDITIONALLY (not just
  // for M365 requests) so finalizeM365Aliases() can exclude any candidate name a REAL tool already
  // owns (e.g. "search"/"fetch"/"recall") regardless of registration order.
  //
  // SCOPE (review finding): candidate collection itself is gated behind isM365StaticAuth() -- an
  // unconditional version would collect (and eventually finalize) a compatibility alias for nearly
  // the whole ~850-tool catalog on EVERY request (Claude Code, Hyperagent, connector clients too),
  // materially inflating tools/list size and prompt-token cost for callers that never needed M365
  // compatibility. Each per-request McpServer instance is stateless (server/mcp.ts), so this
  // correctly scopes the extra registrations to only the M365 static-auth request that needs them.
  //
  // GOVERNANCE BYPASS (review finding, the security one): an alias is a recursive registerTool()
  // call with `{...def, name: aliasName}`, so EVERY name-pattern-based gate inside the handler
  // (requiredRoleFor, lane curation, JIT doctrine) was evaluating against the STRIPPED name, not the
  // real tool -- e.g. "containerapp_get" (alias of the CTO-only azure_containerapp_get) doesn't
  // match the `azure_*` governance pattern, so ANY authenticated lane could call it unrestricted.
  // Fixed by passing `canonicalName: def.name` into the alias's def (see ToolDefinition's doc
  // comment) so those gates evaluate the real tool's identity while `name` stays only the SDK
  // lookup key / what the caller actually invokes.
  if (!isAlias) {
    primaryNamesFor(server).add(def.name);
    if (isM365StaticAuth()) {
      const stripped = /^[^_]+_(.+)$/.exec(def.name);
      if (stripped) {
        const aliasName = stripped[1];
        const bucket = aliasCandidatesFor(server);
        const list = bucket.get(aliasName) ?? [];
        // Type erasure to the WeakMap's fixed shape is safe here: def is only ever forwarded
        // opaquely into a later registerTool() call (finalizeM365Aliases), never inspected by
        // field-specific generic logic.
        list.push({ canonicalName: def.name, def: def as unknown as ToolDefinition<ZodRawShape, ZodRawShape> });
        bucket.set(aliasName, list);
        // DEDUP FIX (2026-08-02): remember this primary's RegisteredTool handle so
        // finalizeM365Aliases() can `.remove()` it once it knows whether `aliasName` actually
        // ended up unambiguous (only known after every tool in this request has registered). See
        // primaryHandlesByServer's header comment above for why this matters.
        primaryHandlesFor(server).set(def.name, registeredHandle);
      }
    }
  }
}

export type CallerHashProvider = () => string;
