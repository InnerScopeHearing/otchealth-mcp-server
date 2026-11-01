import { createSign } from 'node:crypto';
import { loadEnv } from '../config/env.js';
import {
  COMPANY_GITHUB_ALLOWED_OWNERS,
  isCompanyGitHubAllowedOwner,
  isCompanyGitHubOperatorLane,
  isGitHubWriteCarvedOutRepository,
} from '../config/github-operator.js';
import { evaluateGitHubPreShareGate } from '../safety/github-pre-share.js';
import { fetchWithBudget } from '../util/fetch-budget.js';
import { createDeveloperGitUpstream } from './developer-git-upstream.js';
import {
  buildGitHubApiUrl,
  encodeGitHubHierarchicalRoutePath,
  encodeGitHubOpaqueRouteParam,
  encodeGitHubRepositorySegment,
  GitHubPathSafetyError,
} from './path-safety.js';

const env = loadEnv();

export class GitHubApiError extends Error {
  readonly code: string; readonly status: number; readonly nextStep: string;
  constructor(a: { code: string; status: number; message: string; nextStep: string }) {
    super(a.message); this.name = 'GitHubApiError'; this.code = a.code; this.status = a.status; this.nextStep = a.nextStep;
  }
}

/**
 * Repo-scoping guard for non-privileged callers (2026-07-26, hardening follow-up to the
 * otchealth-dev Copilot custom agent wiring / COPILOT_DEV_AGENT_TOKEN). WHY THIS EXISTS: unlike
 * the medreview PHI carve-outs baked into Sentry/PostHog/Customer.io, github_ and depot_ tools had
 * NO repo-level scoping at all -- reach was bounded only by whatever the underlying GitHub App
 * installation could see. The bounded operator surface now has explicit company-lane governance,
 * while every other write_orchestrated tool retains registry.ts's CTO-only default. This guard is
 * called by READ-category tools so non-operator callers cannot read outside a configured repo
 * allowlist.
 *
 * The legacy CTO/Exec identities retain unrestricted diagnostic-read reach. Every other named
 * company GitHub operator is fenced to InnerScopeHearing here as well as on the exact shared
 * 29-tool surface, so an adjacent read cannot bypass the company-owner boundary. Callers outside
 * the named operator set retain the legacy DEVELOPER_ALLOWED_REPOS behavior -- a CSV of
 * "owner/repo" pairs, case-insensitive, env-overridable exactly like GRAPH_CS_MAILBOXES.
 *
 * DEFAULT (env unset/empty) IS UNRESTRICTED -- this ships as a zero-risk, inert control point
 * (Matt's explicit call, 2026-07-26: "unrestricted by default, no behavior change today"), not a
 * live restriction. Narrowing it later is a config change, not a redeploy.
 */
export function assertRepoAllowed(callerAgent: string, owner: string, repo: string): void {
  if (callerAgent === 'cto' || callerAgent === 'exec') return;
  if (isCompanyGitHubOperatorLane(callerAgent)) {
    if (isCompanyGitHubAllowedOwner(owner)) return;
    throw new GitHubApiError({
      code: 'github_owner_not_allowed',
      status: 0,
      message: `Repository owner "${owner}" is outside the company GitHub boundary (${COMPANY_GITHUB_ALLOWED_OWNERS.join('/')}).`,
      nextStep: 'Use a repository owned by InnerScopeHearing.',
    });
  }
  const csv = env.DEVELOPER_ALLOWED_REPOS;
  if (!csv) return; // unrestricted by default -- see header above
  const allowed = new Set(csv.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
  const full = `${owner}/${repo}`.toLowerCase();
  if (!allowed.has(full)) {
    throw new GitHubApiError({
      code: 'repo_not_allowed',
      status: 0,
      message: `Repository "${owner}/${repo}" is not on the allowlist for this caller (see DEVELOPER_ALLOWED_REPOS). This env var is unset by default (unrestricted) -- it was deliberately narrowed for this deployment.`,
      nextStep: 'If this repo should be reachable, add it to DEVELOPER_ALLOWED_REPOS.',
    });
  }
}

function assertCompanyOwner(owner: string): void {
  if (isCompanyGitHubAllowedOwner(owner)) return;
  throw new GitHubApiError({
    code: 'github_owner_not_allowed',
    status: 0,
    message: `Repository owner "${owner}" is outside the company GitHub boundary (${COMPANY_GITHUB_ALLOWED_OWNERS.join('/')}).`,
    nextStep: 'Use a repository owned by InnerScopeHearing.',
  });
}

function assertNotPhi(repo: string): void {
  if (!isGitHubWriteCarvedOutRepository(repo)) return;
  throw new GitHubApiError({
    code: 'github_write_phi_rejected',
    status: 0,
    message: `Write to repo "${repo}" is blocked: medreview/PHI repositories are read-only via this gateway.`,
    nextStep: 'Use a non-PHI repository, or contact the CTO to authorise this operation outside the gateway.',
  });
}

function assertProtectedContent(toolName: string, args: unknown): void {
  const gate = evaluateGitHubPreShareGate(toolName, null, args);
  if (!gate.blocked) return;
  throw new GitHubApiError({
    code: 'github_pre_share_blocked',
    status: 0,
    message: gate.reason,
    nextStep: 'Remove protected/MNPI material and keep it in its authorized private destination.',
  });
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

const GITHUB_API_ORIGIN = 'https://api.github.com';
const GITHUB_REPOSITORY_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

export interface GitHubRepositoryReference {
  owner: string;
  repo: string;
  fullName: string;
}

/**
 * Accept only the two path segments GitHub permits for a repository selector.
 * Webhook payloads are externally supplied, so this check happens before a
 * selector can reach a GitHub API path.
 */
export function parseGitHubRepositoryFullName(value: unknown): GitHubRepositoryReference | null {
  if (typeof value !== 'string') return null;
  const parts = value.split('/');
  if (parts.length !== 2) return null;
  const [owner, repo] = parts;
  if (!owner || !repo || !GITHUB_REPOSITORY_SEGMENT.test(owner) || !GITHUB_REPOSITORY_SEGMENT.test(repo)) return null;
  return { owner, repo, fullName: `${owner}/${repo}` };
}

/** GitHub pull-request numbers are positive safe integers, never arbitrary URL text. */
export function isGitHubPullRequestNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function githubPullRequestPathNumber(value: unknown): string {
  if (!isGitHubPullRequestNumber(value)) {
    throw new GitHubApiError({ code: 'github_invalid_pull_request_number', status: 0, message: 'Refusing an invalid GitHub pull request number.', nextStep: 'Use a positive integer pull request number.' });
  }
  return String(Number(value));
}

/**
 * Construct a request only against the fixed GitHub REST origin. Redirects are
 * refused because an App token must never be forwarded to another authority.
 */
async function githubApiFetch(urlPath: string, init: RequestInit, retries: number): Promise<Response> {
  const url = validatedGitHubApiUrl(urlPath);
  const response = await fetchWithBudget(url, { ...init, redirect: 'error' }, { retries });
  // Native fetch rejects a redirect with redirect:'error'. Keep this guard as
  // defense in depth for alternate fetch implementations and test doubles.
  if (response.redirected || (response.status >= 300 && response.status < 400)) {
    throw new GitHubApiError({ code: 'github_redirect_refused', status: response.status, message: 'Refusing a redirect from the GitHub API.', nextStep: 'Investigate the GitHub API response before retrying.' });
  }
  return response;
}

function validatedGitHubApiUrl(path: string): URL {
  try {
    return buildGitHubApiUrl(path, GITHUB_API_ORIGIN);
  } catch (error) {
    if (error instanceof GitHubPathSafetyError) {
      throw new GitHubApiError({ code: error.code, status: error.status, message: error.message, nextStep: error.nextStep });
    }
    throw error;
  }
}

// Installation token cache
let cachedToken: string | null = null;
let tokenExpiresAt = 0;

async function getInstallationToken(): Promise<string> {
  const now = Date.now();
  // Reuse until ~1 min before expiry
  if (cachedToken && now < tokenExpiresAt - 60_000) return cachedToken;

  const installationId = env.GITHUB_APP_INSTALLATION_ID;
  if (!installationId) throw new GitHubApiError({ code: 'github_not_configured', status: 0, message: 'GITHUB_APP_INSTALLATION_ID not set.', nextStep: 'Add GITHUB_APP_INSTALLATION_ID to the vault.' });

  const accessTokenPath = `/app/installations/${encodeGitHubRepositorySegment(installationId)}/access_tokens`;
  validatedGitHubApiUrl(accessTokenPath);
  const jwt = mintJwt();
  // Token mint is a POST but has no side effect on GitHub state; still, be conservative
  // and do not retry (a second identical mint is wasted, not harmful, but avoids doubt).
  const res = await githubApiFetch(accessTokenPath, {
    method: 'POST',
    headers: { ...GITHUB_HEADERS, Authorization: `Bearer ${jwt}` },
  }, 0);
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
  validatedGitHubApiUrl(path);
  const token = await getInstallationToken();
  // Read-only GET: safe to retry once on a network blip / 429 / 5xx.
  const res = await githubApiFetch(path, {
    method: 'GET',
    headers: { ...GITHUB_HEADERS, Authorization: `Bearer ${token}` },
  }, 1);
  const statusCode = res.status;
  const text = await res.text();
  let data: any;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (statusCode >= 400) throw new GitHubApiError({ code: `github_${statusCode}`, status: statusCode, message: data?.message || `HTTP ${statusCode}`, nextStep: 'Verify GitHub App installation has access to this repository.' });
  return data as T;
}

export async function listPullRequests(owner: string, repo: string, state = 'open'): Promise<any[]> {
  const data = await githubGet<any[]>(`/repos/${encodeGitHubRepositorySegment(owner)}/${encodeGitHubRepositorySegment(repo)}/pulls?state=${encodeURIComponent(state)}&per_page=20`);
  return Array.isArray(data) ? data : [];
}

/**
 * Filters accepted by GET /repos/{owner}/{repo}/actions/runs (GitHub REST API 2022-11-28).
 * All fields are optional; `status` is the only one GitHub restricts to a fixed enum (it folds
 * both "check run status" AND "conclusion" values into this single query parameter for this
 * endpoint -- there is no separate "conclusion" filter on the list-runs endpoint, unlike the
 * single-run object shape which does expose distinct status/conclusion fields).
 */
export interface ListWorkflowRunsFilters {
  status?: string;
  branch?: string;
  event?: string;
  actor?: string;
  created?: string;
  exclude_pull_requests?: boolean;
  check_suite_id?: number;
  head_sha?: string;
  per_page?: number;
  page?: number;
}

export async function listWorkflowRuns(owner: string, repo: string, filters: ListWorkflowRunsFilters = {}): Promise<any[]> {
  const params = new URLSearchParams({ per_page: String(filters.per_page ?? 20) });
  if (filters.page !== undefined) params.set('page', String(filters.page));
  if (filters.status !== undefined) params.set('status', filters.status);
  if (filters.branch !== undefined) params.set('branch', filters.branch);
  if (filters.event !== undefined) params.set('event', filters.event);
  if (filters.actor !== undefined) params.set('actor', filters.actor);
  if (filters.created !== undefined) params.set('created', filters.created);
  if (filters.exclude_pull_requests !== undefined) params.set('exclude_pull_requests', String(filters.exclude_pull_requests));
  if (filters.check_suite_id !== undefined) params.set('check_suite_id', String(filters.check_suite_id));
  if (filters.head_sha !== undefined) params.set('head_sha', filters.head_sha);
  const data = await githubGet<{ workflow_runs: any[] }>(`/repos/${encodeGitHubRepositorySegment(owner)}/${encodeGitHubRepositorySegment(repo)}/actions/runs?${params}`);
  return Array.isArray(data?.workflow_runs) ? data.workflow_runs : [];
}

// ── Writes (App installation token; company-operator-gated at the tool layer) ───────────────
async function githubSend<T = any>(method: 'POST' | 'PATCH' | 'PUT', path: string, body: unknown): Promise<T> {
  validatedGitHubApiUrl(path);
  const token = await getInstallationToken();
  // Non-idempotent write (creates/updates a branch, file, PR, comment, merge, etc.):
  // retries:0 so a timeout never causes a duplicate GitHub mutation.
  const res = await githubApiFetch(path, {
    method,
    headers: { ...GITHUB_HEADERS, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, 0);
  const statusCode = res.status;
  const text = await res.text();
  let data: any;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (statusCode >= 400) throw new GitHubApiError({ code: `github_${statusCode}`, status: statusCode, message: data?.message || `HTTP ${statusCode}`, nextStep: 'Verify the App installation has write access (contents/pull_requests) to this repo and the branch/PR exists.' });
  return data as T;
}

const O = encodeGitHubOpaqueRouteParam;
const S = encodeGitHubRepositorySegment;

/** Read a file's decoded text + sha from a repo (helper for write workflows). */
export async function getFileContents(owner: string, repo: string, path: string, ref?: string): Promise<{ path: string; sha: string; text: string }> {
  if (ref) O(ref);
  const q = ref ? `?${new URLSearchParams({ ref })}` : '';
  const d = await githubGet<any>(`/repos/${S(owner)}/${S(repo)}/contents/${encodeGitHubHierarchicalRoutePath(path)}${q}`);
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
  assertCompanyOwner(owner);
  assertNotPhi(repo);
  assertProtectedContent('github_push_files', { owner, repo, branch, files, message });
  const base = `/repos/${S(owner)}/${S(repo)}`;
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
  return githubGet(`/repos/${S(owner)}/${S(repo)}/commits/${O(sha)}`);
}

export async function getPullRequest(owner: string, repo: string, number: unknown): Promise<any> {
  const pullRequestNumber = githubPullRequestPathNumber(number);
  return githubGet<any>(`/repos/${S(owner)}/${S(repo)}/pulls/${pullRequestNumber}`);
}

export async function createIssueComment(owner: string, repo: string, number: number, body: string): Promise<void> {
  assertCompanyOwner(owner);
  assertNotPhi(repo);
  assertProtectedContent('github_comment_on_issue', { owner, repo, issue_number: number, body });
  await githubSend('POST', `/repos/${S(owner)}/${S(repo)}/issues/${number}/comments`, { body });
}

export async function createPullRequest(
  owner: string, repo: string, title: string, head: string, base: string, body?: string, draft?: boolean,
): Promise<{ number: number; url: string; state: string }> {
  assertCompanyOwner(owner);
  assertNotPhi(repo);
  assertProtectedContent('github_create_pull_request', { owner, repo, title, head, base, body, draft });
  const pr = await githubSend<any>('POST', `/repos/${S(owner)}/${S(repo)}/pulls`, { title, head, base, body: body ?? '', draft: draft ?? false });
  return { number: pr.number, url: pr.html_url, state: pr.state };
}

export async function mergePullRequest(
  owner: string, repo: string, number: unknown, method: 'merge' | 'squash' | 'rebase' = 'squash', title?: string,
  allowReviewedDraftPromotion = false, expectedHeadSha?: string,
): Promise<{ merged: boolean; sha: string; message: string }> {
  if (expectedHeadSha !== undefined && !/^[0-9a-fA-F]{40}$/.test(expectedHeadSha)) {
    throw new GitHubApiError({ code: 'github_invalid_expected_head_sha', status: 0, message: 'Expected head SHA must be exactly 40 hexadecimal characters.', nextStep: 'Pass the exact current pull-request head SHA or omit the optional guard.' });
  }
  assertCompanyOwner(owner);
  assertNotPhi(repo);
  assertProtectedContent('github_merge_pull_request', { owner, repo, number, method, title });
  const pullRequestNumber = githubPullRequestPathNumber(number);
  const reviewedHeads: Record<number, string> = {
    165: '25ee4f3f5f379c1822dec234549f4559778cf8a4',
    166: '80441e7fbac340ece059342d78aba2ce5ab57f27',
  };
  const expectedHead = owner.toLowerCase() === 'innerscopehearing' && repo.toLowerCase() === 'aware-aural-rehab'
    ? reviewedHeads[Number(pullRequestNumber)] : undefined;
  if (expectedHeadSha !== undefined && expectedHead !== undefined && expectedHeadSha.toLowerCase() !== expectedHead) {
    throw new GitHubApiError({ code: 'github_reviewed_merge_guard', status: 0, message: 'The supplied expected head SHA conflicts with the hardcoded reviewed AWARE pull-request head.', nextStep: 'Recheck the reviewed PR and pass its exact authorized head SHA.' });
  }
  const mergeHeadSha = expectedHeadSha?.toLowerCase() ?? expectedHead;
  if (!expectedHead) {
    const r = await githubSend<any>('PUT', `/repos/${S(owner)}/${S(repo)}/pulls/${pullRequestNumber}/merge`, { merge_method: method, ...(mergeHeadSha ? { sha: mergeHeadSha } : {}), ...(title ? { commit_title: title } : {}) });
    return { merged: r.merged === true, sha: r.sha ?? '', message: r.message ?? '' };
  }
  if (!allowReviewedDraftPromotion) {
    // Preserve the pre-existing caller behavior: non-CTO callers make the ordinary
    // merge attempt, but can never trigger the reviewed draft-to-ready transition.
    const r = await githubSend<any>('PUT', `/repos/${S(owner)}/${S(repo)}/pulls/${pullRequestNumber}/merge`, { merge_method: method, sha: expectedHead, ...(title ? { commit_title: title } : {}) });
    return { merged: r.merged === true, sha: r.sha ?? '', message: r.message ?? '' };
  }
  const base = `/repos/${S(owner)}/${S(repo)}`;
  const prPath = `${base}/pulls/${pullRequestNumber}`;
  const assertReviewed = (pr: any, requireReady: boolean) => {
    if (pr?.number !== Number(pullRequestNumber) || pr?.state !== 'open' || pr?.merged !== false || pr?.base?.ref !== 'main' || pr?.base?.repo?.full_name?.toLowerCase() !== `${owner}/${repo}`.toLowerCase() || pr?.head?.sha !== expectedHead || typeof pr?.node_id !== 'string' || pr.node_id.length === 0 || (requireReady && pr?.draft !== false)) {
      throw new GitHubApiError({ code: 'github_reviewed_merge_guard', status: 0, message: 'The reviewed AWARE pull request identity, state, base, draft status, or exact head does not match the authorized merge target.', nextStep: 'Recheck the exact reviewed PR and its current state before retrying.' });
    }
  };
  let pr = await githubGet<any>(prPath);
  assertReviewed(pr, false);
  const originalNodeId = pr.node_id;
  if (pr.draft !== true && pr.draft !== false) throw new GitHubApiError({ code: 'github_reviewed_merge_guard', status: 0, message: 'GitHub did not return a valid draft state for the reviewed pull request.', nextStep: 'Recheck the PR response before retrying.' });
  if (pr.draft && !allowReviewedDraftPromotion) throw new GitHubApiError({ code: 'github_reviewed_merge_guard', status: 0, message: 'Draft promotion requires explicit CTO caller context.', nextStep: 'Use the approved CTO operation after confirming the reviewed PR target.' });

  const required = ['syntax', 'unit', 'a11y', 'gitleaks secret scan', 'Required web release gates', 'trufflehog verified-secret scan'];
  const checkRuns: any[] = [];
  for (let page = 1; page <= 10; page++) {
    const result = await githubGet<any>(`${base}/commits/${O(expectedHead)}/check-runs?filter=latest&per_page=100&page=${page}`);
    const rows = Array.isArray(result?.check_runs) ? result.check_runs : [];
    checkRuns.push(...rows);
    if (rows.length < 100) {
      if (Number(result?.total_count) !== checkRuns.length) throw new GitHubApiError({ code: 'github_reviewed_checks_incomplete', status: 0, message: 'The check-run list is incomplete or paginated ambiguously.', nextStep: 'Wait for GitHub checks to settle and retry the reviewed merge.' });
      break;
    }
    if (page === 10) throw new GitHubApiError({ code: 'github_reviewed_checks_incomplete', status: 0, message: 'The check-run list exceeds the bounded verification window.', nextStep: 'Resolve check-run pagination before retrying.' });
  }
  for (const name of required) {
    const matching = checkRuns.filter((run) => run?.name === name);
    if (matching.length !== 1 || matching[0]?.head_sha !== expectedHead || matching[0]?.app?.id !== 15368 || matching[0]?.status !== 'completed' || matching[0]?.conclusion !== 'success') {
      throw new GitHubApiError({ code: 'github_reviewed_checks_incomplete', status: 0, message: `Required check "${name}" is missing, ambiguous, stale, from an unexpected App, or unsuccessful.`, nextStep: 'Wait for all six required checks on the exact reviewed SHA, then retry.' });
    }
  }
  const protection = await githubGet<any>(`${base}/branches/main/protection`);
  const protectedContexts = protection?.required_status_checks?.contexts;
  const protectedChecks = protection?.required_status_checks?.checks;
  const exactContexts = Array.isArray(protectedContexts) && protectedContexts.length === required.length && required.every((name) => protectedContexts.filter((context: unknown) => context === name).length === 1);
  const exactChecks = Array.isArray(protectedChecks) && protectedChecks.length === required.length && required.every((name) => protectedChecks.filter((check: any) => check?.context === name && check?.app_id === 15368).length === 1);
  if (!exactContexts || !exactChecks) {
    throw new GitHubApiError({ code: 'github_reviewed_protection_missing', status: 0, message: 'The current main-branch protection does not enforce the reviewed six-check App/context set.', nextStep: 'Restore the approved protection policy through its owner-controlled process before retrying.' });
  }
  if (pr.draft) {
    const ready = await githubSend<any>('POST', '/graphql', { query: 'mutation MarkPullRequestReady($pullRequestId: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $pullRequestId }) { pullRequest { id isDraft } } }', variables: { pullRequestId: pr.node_id } });
    const readyPr = ready?.data?.markPullRequestReadyForReview?.pullRequest;
    if (ready?.errors?.length || readyPr?.id !== originalNodeId || readyPr?.isDraft !== false) throw new GitHubApiError({ code: 'github_reviewed_promotion_failed', status: 0, message: 'GitHub did not confirm readiness for the exact reviewed pull request.', nextStep: 'Inspect the PR state before retrying; no merge was attempted.' });
  }
  pr = await githubGet<any>(prPath);
  assertReviewed(pr, true);
  if (pr.node_id !== originalNodeId) throw new GitHubApiError({ code: 'github_reviewed_merge_guard', status: 0, message: 'The pull-request identity changed during readiness verification.', nextStep: 'Recheck the reviewed PR identity before retrying.' });
  const r = await githubSend<any>('PUT', `${base}/pulls/${pullRequestNumber}/merge`, { merge_method: method, sha: expectedHead, ...(title ? { commit_title: title } : {}) });
  return { merged: r.merged === true, sha: r.sha ?? '', message: r.message ?? '' };
}
