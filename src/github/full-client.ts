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
    declaredLength = N…29633 tokens truncated…ngth, 12);
      localParts.push(descriptor);
      descriptorLength = descriptor.length;
    }

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(member.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt32LE(0, 36);
    central.writeUInt32LE(member.externalAttributes ?? 0, 38);
    central.writeUInt32LE(localOffset, 42);
    name.copy(central, 46);
    centralParts.push(central);
    localOffset += local.length + compressed.length + descriptorLength;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(members.length, 8);
  end.writeUInt16LE(members.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(localOffset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

function makeReceipt(overrides: Record<string, unknown> = {}): string {
  const receipt = {
    schema: 'managed-graphrag-company-fifth-source-provider-observation-v2',
    read_only: true,
    knowledge_base_id: KNOWLEDGE_BASE_ID,
    source_id: SOURCE_ID,
    ingestion_job_id: INGESTION_JOB_ID,
    provider_status: 'COMPLETE',
    provider_updated_at: '2026-09-16T12:00:00Z',
    terminal: true,
    terminal_statistics: {
      numberOfDocumentsScanned: 112,
      numberOfNewDocumentsIndexed: 109,
      numberOfModifiedDocumentsIndexed: 0,
      numberOfDocumentsDeleted: 0,
      numberOfDocumentsFailed: 3,
    },
    progress_statistics: null,
    ...overrides,
  };
  return JSON.stringify(receipt);
}

function makeRepo(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: REPOSITORY_ID,
    name: 'otchealth-cto',
    full_name: REPOSITORY,
    owner: { login: 'InnerScopeHearing' },
    ...overrides,
  };
}

function makeRun(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: RUN_ID,
    name: 'Observe sealed company GraphRAG fifth-source ingestion',
    path: WORKFLOW_PATH,
    event: 'workflow_dispatch',
    status: 'completed',
    conclusion: 'success',
    head_branch: 'main',
    head_sha: HEAD_SHA,
    repository: { id: REPOSITORY_ID, full_name: REPOSITORY },
    head_repository: { id: REPOSITORY_ID, full_name: REPOSITORY },
    ...overrides,
  };
}

function makeArtifact(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: ARTIFACT_ID,
    name: ARTIFACT_NAME,
    size_in_bytes: 2048,
    expired: false,
    created_at: '2026-09-16T12:00:00Z',
    expires_at: '2099-01-01T00:00:00Z',
    digest: null,
    workflow_run: {
      id: RUN_ID,
      repository_id: REPOSITORY_ID,
      head_repository_id: REPOSITORY_ID,
      head_branch: 'main',
      head_sha: HEAD_SHA,
    },
    ...overrides,
  };
}

type StubOverrides = {
  tokenMintResponse?: Response;
  repo?: Record<string, unknown>;
  run?: Record<string, unknown>;
  workflowBlobSha?: string;
  producerBlobSha?: string;
  artifact?: Record<string, unknown>;
  archive?: Buffer;
  downloadChunk?: Uint8Array;
  downloadLocation?: string;
};

type CapturedRequest = { url: string; authorization: string | null; method: string };

function githubStub(captured: CapturedRequest[], overrides: StubOverrides = {}): typeof fetch {
  const archive = overrides.archive ?? zipStore([{ name: 'receipt.json', data: Buffer.from(makeReceipt(), 'utf8') }]);
  return (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const headers = new Headers(init.headers);
    captured.push({ url: url.toString(), authorization: headers.get('authorization'), method: init.method ?? 'GET' });

    if (url.origin === 'https://api.github.com' && url.pathname === '/app/installations/789/access_tokens') {
      if (overrides.tokenMintResponse) return overrides.tokenMintResponse;
      return new Response(JSON.stringify({ token: 'ghs_test_token', expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString() }), { status: 201 });
    }
    if (url.origin === 'https://api.github.com' && url.pathname === `/repos/${REPOSITORY}`) {
      return new Response(JSON.stringify(overrides.repo ?? makeRepo()), { status: 200 });
    }
    if (url.origin === 'https://api.github.com' && url.pathname === `/repos/${REPOSITORY}/actions/runs/${RUN_ID}`) {
      return new Response(JSON.stringify(overrides.run ?? makeRun()), { status: 200 });
    }
    if (url.origin === 'https://api.github.com' && url.pathname === `/repos/${REPOSITORY}/contents/.github/workflows/observe-managed-graphrag-company-fifth-source.yml`) {
      return new Response(JSON.stringify({ type: 'file', path: '.github/workflows/observe-managed-graphrag-company-fifth-source.yml', sha: overrides.workflowBlobSha ?? WORKFLOW_BLOB_SHA }), { status: 200 });
    }
    if (url.origin === 'https://api.github.com' && url.pathname === `/repos/${REPOSITORY}/contents/scripts/observe_managed_graphrag_company_fifth_source.py`) {
      return new Response(JSON.stringify({ type: 'file', path: 'scripts/observe_managed_graphrag_company_fifth_source.py', sha: overrides.producerBlobSha ?? PRODUCER_BLOB_SHA }), { status: 200 });
    }
    if (url.origin === 'https://api.github.com' && url.pathname === `/repos/${REPOSITORY}/actions/artifacts/${ARTIFACT_ID}`) {
      return new Response(JSON.stringify(overrides.artifact ?? makeArtifact()), { status: 200 });
    }
    if (url.origin === 'https://api.github.com' && url.pathname === `/repos/${REPOSITORY}/actions/artifacts/${ARTIFACT_ID}/zip`) {
      return new Response(null, { status: 302, headers: { location: overrides.downloadLocation ?? DOWNLOAD_URL } });
    }
    if (url.toString() === (overrides.downloadLocation ?? DOWNLOAD_URL)) {
      const chunk = overrides.downloadChunk;
      if (chunk) {
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(chunk);
            controller.close();
          },
        }), { status: 200 });
      }
      return new Response(archive, { status: 200, headers: { 'content-length': String(archive.length) } });
    }
    throw new Error('unexpected mocked GitHub request');
  }) as typeof fetch;
}

async function withStubbedFetch<T>(stub: typeof fetch, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

async function callThroughRealMcpServer(
  args: Record<string, unknown> = {},
  callerAgent = 'cto',
): Promise<{ isError?: boolean; content: Array<{ type: string; text?: string }>; structuredContent?: any }> {
  const { registerGitHubGraphRagObservationReceipt } = await import('./graphrag-observation-receipt.js');
  const { requestContext } = await import('../../server/request-context.js');
  const mcp = new McpServer({ name: 'test', version: '0' }, { capabilities: { tools: { listChanged: true }, logging: {} } });
  registerGitHubGraphRagObservationReceipt(mcp, () => 'test-caller-hash');

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0' }, { capabilities: {} });
  await Promise.all([mcp.connect(serverTransport), client.connect(clientTransport)]);
  try {
    return await requestContext.run(
      { callerHash: 'test-caller-hash', correlationId: 'test-correlation', callerAgent },
      () => client.callTool({ name: 'github_graphrag_observation_receipt_get', arguments: args }) as ReturnType<typeof client.callTool>,
    );
  } finally {
    await client.close();
    await mcp.close();
  }
}

test('pinned observation reader bounds and validates installation-token mint responses', async (t) => {
  await t.test('oversized token response is rejected before its body is consumed', async () => {
    const requests: CapturedRequest[] = [];
    const tokenResponseBody = Buffer.from(`oversized-token-sentinel-${'x'.repeat(16 * 1024)}`);
    let bodyPulled = false;
    let bodyCancelled = false;
    const tokenMintResponse = new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        bodyPulled = true;
        controller.enqueue(tokenResponseBody);
        controller.close();
      },
      cancel() {
        bodyCancelled = true;
      },
    }, { highWaterMark: 0 }), {
      status: 201,
      headers: { 'content-length': String(tokenResponseBody.length) },
    });

    const result = await withStubbedFetch(
      githubStub(requests, { tokenMintResponse }),
      () => callThroughRealMcpServer(),
    );

    assert.equal(result.isError, true);
    assert.equal(bodyPulled, false, 'a declared oversized body must be rejected before reading');
    assert.equal(bodyCancelled, true, 'the oversized response body must be cancelled');
    assert.equal(requests.length, 1, 'no repository request should follow a rejected token response');
    assert.equal(JSON.stringify(result).includes('oversized-token-sentinel'), false);
  });

  await t.test('oversized streamed token chunk is rejected before copying', async () => {
    const requests: CapturedRequest[] = [];
    const oversizedChunk = new Uint8Array(16 * 1024 + 1).fill(0x61);
    let bodyPulled = false;
    let bodyDrained = false;
    let bodyCancelled = false;
    let pullCount = 0;
    const tokenMintResponse = new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pullCount++ === 0) {
          bodyPulled = true;
          controller.enqueue(oversizedChunk);
          return;
        }
        bodyDrained = true;
        controller.close();
      },
      cancel() {
        bodyCancelled = true;
      },
    }, { highWaterMark: 0 }), { status: 201 });

    const originalBufferFrom = Buffer.from;
    let copiedOversizedChunk = false;
    let result: Awaited<ReturnType<typeof callThroughRealMcpServer>>;
    Buffer.from = ((value: unknown, ...args: unknown[]) => {
      if (value === oversizedChunk) copiedOversizedChunk = true;
      return Reflect.apply(originalBufferFrom, Buffer, [value, ...args]);
    }) as typeof Buffer.from;
    try {
      result = await withStubbedFetch(
        githubStub(requests, { tokenMintResponse }),
        () => callThroughRealMcpServer(),
      );
    } finally {
      Buffer.from = originalBufferFrom;
    }

    assert.equal(result.isError, true);
    assert.equal(bodyPulled, true, 'the reader must inspect a streamed chunk without a declared length');
    assert.equal(bodyDrained, false, 'the body must be cancelled rather than fully drained');
    assert.equal(bodyCancelled, true, 'the oversized stream must be cancelled');
    assert.equal(copiedOversizedChunk, false, 'the oversized chunk must be rejected before Buffer.from copies it');
    assert.equal(requests.length, 1, 'no repository request should follow a rejected token response');
  });

  await t.test('malformed token JSON becomes a sanitized reader failure', async () => {
    const requests: CapturedRequest[] = [];
    const tokenMintResponse = new Response('malformed-token-provider-sentinel', { status: 201 });
    const result = await withStubbedFetch(
      githubStub(requests, { tokenMintResponse }),
      () => callThroughRealMcpServer(),
    );

    assert.equal(result.isError, true);
    assert.equal(JSON.stringify(result).includes('malformed-token-provider-sentinel'), false);
    assert.equal(requests.length, 1);
  });

  await t.test('invalid token shape becomes a sanitized reader failure', async () => {
    const requests: CapturedRequest[] = [];
    const tokenMintResponse = new Response(JSON.stringify({
      message: 'invalid-token-shape-sentinel',
      token: null,
      expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    }), { status: 201 });
    const result = await withStubbedFetch(
      githubStub(requests, { tokenMintResponse }),
      () => callThroughRealMcpServer(),
    );

    assert.equal(result.isError, true);
    assert.equal(JSON.stringify(result).includes('invalid-token-shape-sentinel'), false);
    assert.equal(requests.length, 1);
  });

  await t.test('provider error body becomes a sanitized reader failure', async () => {
    const requests: CapturedRequest[] = [];
    const tokenMintResponse = new Response(JSON.stringify({ message: 'provider-error-body-sentinel' }), { status: 500 });
    const result = await withStubbedFetch(
      githubStub(requests, { tokenMintResponse }),
      () => callThroughRealMcpServer(),
    );

    assert.equal(result.isError, true);
    assert.equal(JSON.stringify(result).includes('provider-error-body-sentinel'), false);
    assert.equal(requests.length, 1);
  });

  await t.test('valid bounded token response allows the fixed receipt read', async () => {
    const requests: CapturedRequest[] = [];
    const result = await withStubbedFetch(githubStub(requests), () => callThroughRealMcpServer());

    assert.equal(result.isError, undefined);
    assert.equal(requests.filter((request) => request.url.endsWith('/app/installations/789/access_tokens')).length, 1);
    assert.ok(requests.some((request) =>
      request.url === `https://api.github.com/repos/${REPOSITORY}` && request.authorization === 'Bearer ghs_test_token'));
  });
});

test('pinned observation read verifies provenance, returns only sanitized structure, and drops auth at the signed download boundary', async () => {
  const requests: CapturedRequest[] = [];
  const archive = zipStore([{ name: 'receipt.json', data: Buffer.from(makeReceipt(), 'utf8') }]);
  const digest = createHash('sha256').update(archive).digest('hex');
  const artifact = makeArtifact({ digest: `sha256:${digest}`, size_in_bytes: archive.length });
  const result = await withStubbedFetch(githubStub(requests, { archive, artifact }), () => callThroughRealMcpServer());

  assert.ok(!result.isError, `expected success, got ${JSON.stringify(result)}`);
  const output = result.structuredContent?.result;
  assert.equal(output.schema, 'otchealth-github-managed-graphrag-observation-validation-v1');
  assert.equal(output.run_id, RUN_ID);
  assert.equal(output.artifact_id, ARTIFACT_ID);
  assert.equal(output.knowledge_base_binding_verified, true);
  assert.equal(output.source_id, SOURCE_ID);
  assert.equal(output.ingestion_job_id, INGESTION_JOB_ID);
  assert.equal(output.provider_status, 'COMPLETE');
  assert.equal(output.terminal, true);
  assert.deepEqual(output.terminal_statistics, {
    numberOfDocumentsScanned: 112,
    numberOfNewDocumentsIndexed: 109,
    numberOfModifiedDocumentsIndexed: 0,
    numberOfDocumentsDeleted: 0,
    numberOfDocumentsFailed: 3,
  });
  assert.equal(output.progress_statistics, null);
  assert.equal(output.workflow_provenance_verified, true);
  assert.equal(output.archive_digest_verification, 'verified');
  assert.equal(output.receipt_sha256.length, 64);
  assert.equal(output.archive_sha256.length, 64);
  assert.equal(JSON.stringify(output).includes('mock-sensitive-url'), false);
  assert.equal(Object.hasOwn(output, 'provider_updated_at'), false);
  assert.equal(output.provider_updated_at_present, true);
  assert.equal(JSON.stringify(output).includes('raw'), false);

  const archiveRequest = requests.find((request) => request.url === `https://api.github.com/repos/${REPOSITORY}/actions/artifacts/${ARTIFACT_ID}/zip`);
  const signedDownloadRequest = requests.find((request) => request.url === DOWNLOAD_URL);
  assert.ok(archiveRequest?.authorization?.startsWith('Bearer '), 'the API archive request must use the installation token');
  assert.ok(signedDownloadRequest, 'the GitHub-provided signed URL must be fetched');
  assert.equal(signedDownloadRequest.authorization, null, 'the GitHub installation token must not cross the redirect boundary');
  assert.ok(requests.some((request) => request.url.includes(`/contents/.github/workflows/observe-managed-graphrag-company-fifth-source.yml?ref=${HEAD_SHA}`)));
  assert.ok(requests.some((request) => request.url.includes(`/contents/scripts/observe_managed_graphrag_company_fifth_source.py?ref=${HEAD_SHA}`)));
});

test('pinned observation read explicitly records when GitHub does not provide an archive digest', async () => {
  const requests: CapturedRequest[] = [];
  const result = await withStubbedFetch(githubStub(requests, { artifact: makeArtifact({ digest: null }) }), () => callThroughRealMcpServer());
  assert.ok(!result.isError, `expected success, got ${JSON.stringify(result)}`);
  assert.equal(result.structuredContent?.result.archive_digest_verification, 'not_provided');
});

test('pinned observation read permits the fixed GitHub Actions artifact storage redirect without forwarding auth', async () => {
  const requests: CapturedRequest[] = [];
  const result = await withStubbedFetch(
    githubStub(requests, { downloadLocation: GITHUB_ACTIONS_STORAGE_URL }),
    () => callThroughRealMcpServer(),
  );

  assert.ok(!result.isError, `expected success, got ${JSON.stringify(result)}`);
  const storageRequest = requests.find((request) => request.url === GITHUB_ACTIONS_STORAGE_URL);
  assert.ok(storageRequest, 'the exact GitHub Actions artifact storage URL should be fetched');
  assert.equal(storageRequest.authorization, null, 'the GitHub installation token must not cross the storage redirect boundary');
  assert.equal(JSON.stringify(result.structuredContent).includes('mock-sensitive-url'), false, 'the signed storage URL must not appear in the receipt');
});

test('pinned observation read permits a known nonzero GitHub Actions storage shard', async () => {
  const requests: CapturedRequest[] = [];
  const result = await withStubbedFetch(
    githubStub(requests, { downloadLocation: GITHUB_ACTIONS_STORAGE_URL_18 }),
    () => callThroughRealMcpServer(),
  );

  assert.ok(!result.isError, `expected success, got ${JSON.stringify(result)}`);
  const storageRequest = requests.find((request) => request.url === GITHUB_ACTIONS_STORAGE_URL_18);
  assert.ok(storageRequest, 'the known shard-18 artifact URL should be fetched');
  assert.equal(storageRequest.authorization, null, 'the GitHub installation token must not cross the storage redirect boundary');
});

test('pinned observation read validates a bounded deflated single-member ZIP with a data descriptor', async () => {
  const requests: CapturedRequest[] = [];
  const archive = zipStore([{
    name: 'receipt.json',
    data: Buffer.from(makeReceipt(), 'utf8'),
    method: 'deflate',
    dataDescriptor: true,
  }]);
  const digest = createHash('sha256').update(archive).digest('hex');
  const artifact = makeArtifact({ digest: `sha256:${digest}`, size_in_bytes: archive.length });
  const result = await withStubbedFetch(githubStub(requests, { archive, artifact }), () => callThroughRealMcpServer());
  assert.ok(!result.isError, `expected success, got ${JSON.stringify(result)}`);
  assert.equal(result.structuredContent?.result.archive_digest_verification, 'verified');
  assert.equal(result.structuredContent?.result.terminal, true);
});

test('pinned observation read refuses wrong run provenance before downloading any archive', async () => {
  const requests: CapturedRequest[] = [];
  const result = await withStubbedFetch(
    githubStub(requests, { run: makeRun({ head_sha: '0'.repeat(40) }) }),
    () => callThroughRealMcpServer(),
  );

  assert.equal(result.isError, true);
  assert.equal(requests.some((request) => request.url.endsWith(`/actions/artifacts/${ARTIFACT_ID}/zip`)), false);
  assert.equal(JSON.stringify(result).includes(HEAD_SHA), false);
});

test('pinned observation read refuses a changed producer source or artifact run binding', async (t) => {
  await t.test('producer blob changed', async () => {
    const requests: CapturedRequest[] = [];
    const result = await withStubbedFetch(
      githubStub(requests, { producerBlobSha: '0'.repeat(40) }),
      () => callThroughRealMcpServer(),
    );
    assert.equal(result.isError, true);
    assert.equal(requests.some((request) => request.url.includes(`/actions/artifacts/${ARTIFACT_ID}`)), false);
  });

  await t.test('artifact bound to another head', async () => {
    const requests: CapturedRequest[] = [];
    const artifact = makeArtifact({
      workflow_run: {
        id: RUN_ID,
        repository_id: REPOSITORY_ID,
        head_repository_id: REPOSITORY_ID,
        head_branch: 'main',
        head_sha: '0'.repeat(40),
      },
    });
    const result = await withStubbedFetch(githubStub(requests, { artifact }), () => callThroughRealMcpServer());
    assert.equal(result.isError, true);
    assert.equal(requests.some((request) => request.url.endsWith(`/actions/artifacts/${ARTIFACT_ID}/zip`)), false);
  });
});

test('pinned observation read refuses expired artifacts and mismatching GitHub archive digests', async (t) => {
  await t.test('expired artifact', async () => {
    const requests: CapturedRequest[] = [];
    const expired = makeArtifact({ expired: true, expires_at: '2020-01-01T00:00:00Z' });
    const result = await withStubbedFetch(githubStub(requests, { artifact: expired }), () => callThroughRealMcpServer());
    assert.equal(result.isError, true);
    assert.equal(requests.some((request) => request.url.endsWith(`/actions/artifacts/${ARTIFACT_ID}/zip`)), false);
  });

  await t.test('digest mismatch', async () => {
    const requests: CapturedRequest[] = [];
    const artifact = makeArtifact({ digest: `sha256:${'0'.repeat(64)}` });
    const result = await withStubbedFetch(githubStub(requests, { artifact }), () => callThroughRealMcpServer());
    assert.equal(result.isError, true);
    assert.equal(JSON.stringify(result).includes('0'.repeat(64)), false);
  });

  await t.test('malformed digest', async () => {
    const requests: CapturedRequest[] = [];
    const artifact = makeArtifact({ digest: 'md5:abcd' });
    const result = await withStubbedFetch(githubStub(requests, { artifact }), () => callThroughRealMcpServer());
    assert.equal(result.isError, true);
  });

  await t.test('artifact metadata size above the archive cap', async () => {
    const requests: CapturedRequest[] = [];
    const artifact = makeArtifact({ size_in_bytes: 1024 * 1024 + 1 });
    const result = await withStubbedFetch(githubStub(requests, { artifact }), () => callThroughRealMcpServer());
    assert.equal(result.isError, true);
    assert.equal(requests.some((request) => request.url.endsWith(`/actions/artifacts/${ARTIFACT_ID}/zip`)), false);
  });
});

test('pinned observation read rejects any archive with extra or unsafe members', async (t) => {
  await t.test('extra member', async () => {
    const requests: CapturedRequest[] = [];
    const archive = zipStore([
      { name: 'receipt.json', data: Buffer.from(makeReceipt(), 'utf8') },
      { name: 'private.txt', data: Buffer.from('never return', 'utf8') },
    ]);
    const result = await withStubbedFetch(githubStub(requests, { archive }), () => callThroughRealMcpServer());
    assert.equal(result.isError, true);
    assert.equal(JSON.stringify(result).includes('never return'), false);
  });

  await t.test('unsafe member path', async () => {
    const requests: CapturedRequest[] = [];
    const archive = zipStore([{ name: '../receipt.json', data: Buffer.from(makeReceipt(), 'utf8') }]);
    const result = await withStubbedFetch(githubStub(requests, { archive }), () => callThroughRealMcpServer());
    assert.equal(result.isError, true);
  });

  await t.test('archive byte limit', async () => {
    const requests: CapturedRequest[] = [];
    const archive = Buffer.alloc(1024 * 1024 + 1);
    const result = await withStubbedFetch(githubStub(requests, { archive }), () => callThroughRealMcpServer());
    assert.equal(result.isError, true);
  });

  await t.test('single oversized response chunk is rejected before copying', async () => {
    const requests: CapturedRequest[] = [];
    const oversizedChunk = new Uint8Array(MAX_GRAPHRAG_ARCHIVE_BYTES + 1);
    const stub = githubStub(requests, { downloadChunk: oversizedChunk });
    const originalBufferFrom = Buffer.from;
    let copiedOversizedChunk = false;
    let result: Awaited<ReturnType<typeof callThroughRealMcpServer>>;

    Buffer.from = ((value: unknown, ...args: unknown[]) => {
      if (value === oversizedChunk) {
        copiedOversizedChunk = true;
        throw new Error('oversized response chunk reached Buffer.from');
      }
      return Reflect.apply(originalBufferFrom, Buffer, [value, ...args]);
    }) as typeof Buffer.from;
    try {
      result = await withStubbedFetch(stub, () => callThroughRealMcpServer());
    } finally {
      Buffer.from = originalBufferFrom;
    }

    assert.equal(result.isError, true);
    assert.ok(requests.some((request) => request.url === DOWNLOAD_URL), 'the test must reach the streamed archive response');
    assert.equal(copiedOversizedChunk, false, 'the oversized chunk must be rejected before Buffer.from copies it');
  });

  await t.test('receipt extraction byte limit', async () => {
    const requests: CapturedRequest[] = [];
    const oversized = Buffer.alloc(32 * 1024 + 1, 0x61);
    const archive = zipStore([{ name: 'receipt.json', data: oversized }]);
    const result = await withStubbedFetch(githubStub(requests, { archive }), () => callThroughRealMcpServer());
    assert.equal(result.isError, true);
  });

  for (const [name, downloadLocation] of [
    ['untrusted public host', 'https://evil.example/download?sig=do-not-follow'],
    ['unlisted GitHub Actions subdomain', 'https://evil.actions.githubusercontent.com/download?sig=do-not-follow'],
    ['unrelated blob account', 'https://example.blob.core.windows.net/actions-results/35170671551/10476469182/fixture.zip?sig=do-not-follow'],
    ['out-of-range GitHub Actions storage shard', 'https://productionresultssa20.blob.core.windows.net/actions-results/35170671551/10476469182/fixture.zip?sig=do-not-follow'],
    ['GitHub storage host outside artifact path', 'https://productionresultssa0.blob.core.windows.net/company-data/fixture.zip?sig=do-not-follow'],
    ['non-HTTPS GitHub storage URL', 'http://productionresultssa0.blob.core.windows.net/actions-results/35170671551/10476469182/fixture.zip?sig=do-not-follow'],
    ['credentialed GitHub storage URL', 'https://fixture-user@productionresultssa0.blob.core.windows.net/actions-results/35170671551/10476469182/fixture.zip?sig=do-not-follow'],
    ['password-bearing GitHub storage URL', 'https://fixture-user:fixture-pass@productionresultssa0.blob.core.windows.net/actions-results/35170671551/10476469182/fixture.zip?sig=do-not-follow'],
    ['nonstandard GitHub storage port', 'https://productionresultssa0.blob.core.windows.net:444/actions-results/35170671551/10476469182/fixture.zip?sig=do-not-follow'],
    ['fragment on GitHub storage URL', 'https://productionresultssa0.blob.core.windows.net/actions-results/35170671551/10476469182/fixture.zip?sig=do-not-follow#fragment'],
  ] as const) {
    await t.test(name, async () => {
      const requests: CapturedRequest[] = [];
      const result = await withStubbedFetch(
        githubStub(requests, { downloadLocation }),
        () => callThroughRealMcpServer(),
      );
      assert.equal(result.isError, true);
      assert.equal(requests.some((request) => request.url === downloadLocation), false, 'untrusted storage URL must not be fetched');
      assert.equal(JSON.stringify(result).includes('do-not-follow'), false, 'the rejected signed URL must not be exposed');
    });
  }
});

test('pinned observation read rejects duplicate JSON keys and nonterminal/incorrectly bound receipts cannot imply terminal success', async (t) => {
  await t.test('duplicate schema key', async () => {
    const requests: CapturedRequest[] = [];
    const raw = makeReceipt().replace('"schema":"managed-graphrag-company-fifth-source-provider-observation-v2"', '"schema":"wrong","schema":"managed-graphrag-company-fifth-source-provider-observation-v2"');
    const archive = zipStore([{ name: 'receipt.json', data: Buffer.from(raw, 'utf8') }]);
    const result = await withStubbedFetch(githubStub(requests, { archive }), () => callThroughRealMcpServer());
    assert.equal(result.isError, true);
  });

  await t.test('source mismatch', async () => {
    const requests: CapturedRequest[] = [];
    const archive = zipStore([{ name: 'receipt.json', data: Buffer.from(makeReceipt({ source_id: 'AAAAAAAAAA' }), 'utf8') }]);
    const result = await withStubbedFetch(githubStub(requests, { archive }), () => callThroughRealMcpServer());
    assert.equal(result.isError, true);
  });

  await t.test('unrecognized top-level field', async () => {
    const requests: CapturedRequest[] = [];
    const archive = zipStore([{ name: 'receipt.json', data: Buffer.from(makeReceipt({ document_text: 'must not pass through' }), 'utf8') }]);
    const result = await withStubbedFetch(githubStub(requests, { archive }), () => callThroughRealMcpServer());
    assert.equal(result.isError, true);
    assert.equal(JSON.stringify(result).includes('must not pass through'), false);
  });

  await t.test('boolean counter is not accepted as an integer', async () => {
    const requests: CapturedRequest[] = [];
    const archive = zipStore([{ name: 'receipt.json', data: Buffer.from(makeReceipt({
      terminal_statistics: {
        numberOfDocumentsScanned: 112,
        numberOfNewDocumentsIndexed: 109,
        numberOfModifiedDocumentsIndexed: 0,
        numberOfDocumentsDeleted: 0,
        numberOfDocumentsFailed: true,
      },
    }), 'utf8') }]);
    const result = await withStubbedFetch(githubStub(requests, { archive }), () => callThroughRealMcpServer());
    assert.equal(result.isError, true);
  });

  await t.test('terminal flag must agree with provider terminal status', async () => {
    const requests: CapturedRequest[] = [];
    const archive = zipStore([{ name: 'receipt.json', data: Buffer.from(makeReceipt({ terminal: false }), 'utf8') }]);
    const result = await withStubbedFetch(githubStub(requests, { archive }), () => callThroughRealMcpServer());
    assert.equal(result.isError, true);
  });

  await t.test('nonterminal observation', async () => {
    const requests: CapturedRequest[] = [];
    const archive = zipStore([{ name: 'receipt.json', data: Buffer.from(makeReceipt({
      provider_status: 'IN_PROGRESS',
      terminal: false,
      terminal_statistics: null,
      progress_statistics: { numberOfDocumentsScanned: 17 },
    }), 'utf8') }]);
    const result = await withStubbedFetch(githubStub(requests, { archive }), () => callThroughRealMcpServer());
    assert.ok(!result.isError, `expected the valid progress observation to be represented, got ${JSON.stringify(result)}`);
    assert.equal(result.structuredContent?.result.terminal, false);
    assert.equal(result.structuredContent?.result.provider_status, 'NONTERMINAL');
    assert.deepEqual(result.structuredContent?.result.progress_statistics, { numberOfDocumentsScanned: 17 });
    assert.notEqual(result.structuredContent?.result.status, 'terminal_observation_validated');
  });
});

test('pinned observation reader is CTO-only', async () => {
  const requests: CapturedRequest[] = [];
  const result = await withStubbedFetch(githubStub(requests), () => callThroughRealMcpServer({}, 'developer'));
  assert.equal(result.isError, true);
  assert.equal(requests.length, 0, 'role refusal must happen before GitHub API access');
});

test('pinned observation failure exposes only an allowlisted stage to CTO', async () => {
  const requests: CapturedRequest[] = [];
  const archive = zipStore([{ name: 'receipt.json', data: Buffer.from(makeReceipt(), 'utf8') }]);
  const artifact = makeArtifact({
    digest: `sha256:${'0'.repeat(64)}`,
    size_in_bytes: archive.length,
    provider_metadata_sentinel: 'synthetic-provider-metadata-must-not-leak',
  });
  const result = await withStubbedFetch(
    githubStub(requests, { archive, artifact }),
    () => callThroughRealMcpServer(),
  );

  assert.equal(result.isError, true);
  const correlationId = result.structuredContent?.correlation_id;
  assert.equal(typeof correlationId, 'string');
  assert.equal(result.structuredContent?.error?.code, 'github_observation_receipt_unverified');
  assert.equal(result.structuredContent?.error?.message, 'The pinned GraphRAG observation receipt could not be verified.');
  assert.deepEqual(result.structuredContent?.error?.internal_diagnostic, {
    type: 'github_observation_receipt',
    stage: 'archive_digest',
    correlation_id: correlationId,
  });
  assert.equal(result.content[0]?.text?.includes('archive_digest'), false, 'user-facing text must remain generic');
  assert.equal(JSON.stringify(result).includes('synthetic-provider-metadata-must-not-leak'), false);
  assert.equal(JSON.stringify(result).includes('mock-sensitive-url'), false);
  assert.equal(JSON.stringify(result).includes('ghs_test_token'), false);
  assert.ok(requests.some((request) => request.url === DOWNLOAD_URL), 'the validated receipt ZIP must be downloaded before digest failure');
});

test('non-CTO failure responses never include pinned observation diagnostics', async () => {
  const requests: CapturedRequest[] = [];
  const artifact = makeArtifact({
    name: 'synthetic-provider-metadata-must-not-leak',
    provider_metadata_sentinel: 'synthetic-provider-metadata-must-not-leak',
  });
  const result = await withStubbedFetch(
    githubStub(requests, { artifact }),
    () => callThroughRealMcpServer({}, 'developer'),
  );

  assert.equal(result.isError, true);
  assert.equal(typeof result.structuredContent?.correlation_id, 'string');
  assert.equal(result.structuredContent?.error?.internal_diagnostic, undefined);
  assert.equal(JSON.stringify(result).includes('archive_digest'), false);
  assert.equal(JSON.stringify(result).includes('synthetic-provider-metadata-must-not-leak'), false);
  assert.equal(requests.length, 0, 'non-CTO role refusal must happen before GitHub API access');
});
