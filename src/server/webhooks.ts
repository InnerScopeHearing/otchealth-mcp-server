import crypto from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { loadEnv } from '../config/env.js';
import { logger } from '../audit/logger.js';
import { getPullRequest, mergePullRequest, createIssueComment } from '../github/api-client.js';

const env = loadEnv();

/** Route a fleet-medic alert to the central, human+agent-visible log issue (App token). */
async function postAlert(body: string): Promise<void> {
  const target = env.FLEET_MEDIC_LOG_REPO;
  const issue = parseInt(env.FLEET_MEDIC_LOG_ISSUE || '0', 10);
  if (!target || !issue) return;
  const [owner, repo] = target.split('/');
  if (!owner || !repo) return;
  try {
    await createIssueComment(owner, repo, issue, body);
  } catch (e) {
    logger.warn({ type: 'fleet_medic_alert_route_failed', error: (e as Error).message }, 'could not post fleet-medic alert to log issue');
  }
}

const AGENT_LOGIN = /(?:^|[-/])(?:openai-code-agent|anthropic-code-agent)$|copilot/i;

/**
 * Fleet-medic v2 auto-merge: when a check suite goes green on an AGENT-authored PR, attempt a
 * squash merge via the App token. GitHub branch protection (required checks/reviews) is the real
 * gate — if it isn't satisfied the merge call fails harmlessly. Only agent PRs; humans unaffected.
 */
async function tryAutoMerge(repoFull: string, prNumbers: number[]): Promise<void> {
  if (!env.FLEET_MEDIC_AUTOMERGE) return;
  const [owner, repo] = repoFull.split('/');
  if (!owner || !repo) return;
  for (const n of prNumbers.slice(0, 5)) {
    try {
      const pr = await getPullRequest(owner, repo, n);
      const login = pr?.user?.login ?? '';
      if (pr?.state !== 'open' || pr?.draft || !AGENT_LOGIN.test(login)) continue;
      const res = await mergePullRequest(owner, repo, n, 'squash', `auto-merge agent PR #${n} (checks green)`);
      logger.info(
        { type: 'fleet_medic_action', rule: 'auto_merge', repo: repoFull, pr: n, agent: login, merged: res.merged, sha: res.sha?.slice(0, 12), msg: res.message },
        `FLEET-MEDIC v2: auto-merge agent PR #${n} (${repoFull}) merged=${res.merged}`,
      );
      if (res.merged) void postAlert(`✅ **Auto-merged** agent PR #${n} in \`${repoFull}\` (${login}, checks green).`);
    } catch (e) {
      logger.warn({ type: 'fleet_medic_action', rule: 'auto_merge', repo: repoFull, pr: n, error: (e as Error).message }, `FLEET-MEDIC v2: auto-merge PR #${n} blocked (likely branch protection): ${(e as Error).message}`);
    }
  }
}

function verifySignature(raw: string, sigHeader: string | undefined, secret: string): boolean {
  if (!sigHeader || !sigHeader.startsWith('sha256=')) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex');
  const a = Buffer.from(sigHeader);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

const FAIL_CONCLUSIONS = new Set(['failure', 'timed_out', 'startup_failure', 'cancelled', 'action_required']);

/**
 * GitHub webhook ingestion + first fleet-medic rules.
 * - HMAC-verified (GITHUB_WEBHOOK_SECRET). Inert (503) when the secret is unset.
 * - Records every event (structured log -> Log Analytics).
 * - Fleet-medic v1 (observational, safe): flags CI failures and surfaces autonomous-agent PR activity.
 *   Auto-actions (e.g. auto-merge agent PRs on green) are intentionally a later, gated rule.
 */
export function registerWebhookRoutes(app: FastifyInstance): void {
  app.post('/webhooks/github', async (request: FastifyRequest, reply) => {
    const secret = env.GITHUB_WEBHOOK_SECRET;
    if (!secret) {
      return reply.code(503).send({ error: 'webhooks_disabled', message: 'GITHUB_WEBHOOK_SECRET not configured.' });
    }
    const raw = (request as FastifyRequest & { rawBody?: string }).rawBody ?? '';
    const sig = request.headers['x-hub-signature-256'] as string | undefined;
    if (!verifySignature(raw, sig, secret)) {
      logger.warn({ type: 'github_webhook_rejected', reason: 'bad_signature' }, 'github webhook signature mismatch');
      return reply.code(401).send({ error: 'invalid_signature' });
    }

    const event = (request.headers['x-github-event'] as string) || 'unknown';
    const p = (request.body ?? {}) as Record<string, any>;
    const repo = p.repository?.full_name ?? 'unknown';
    const action = p.action ?? '';
    const delivery = request.headers['x-github-delivery'] as string | undefined;

    logger.info({ type: 'github_webhook', event, action, repo, delivery }, 'github webhook received');

    // ── Fleet-medic rule 1: CI / check failure on a repo ──────────────────────
    if (event === 'workflow_run' || event === 'check_suite') {
      const node = event === 'workflow_run' ? p.workflow_run : p.check_suite;
      const conclusion = node?.conclusion;
      // v2: on GREEN, attempt auto-merge of any agent-authored PR tied to this run.
      if (conclusion === 'success') {
        const prNums = (node?.pull_requests ?? []).map((x: any) => x?.number).filter((x: any) => typeof x === 'number');
        if (prNums.length) void tryAutoMerge(repo, prNums);
      }
      if (conclusion && FAIL_CONCLUSIONS.has(conclusion)) {
        logger.warn(
          {
            type: 'fleet_medic_alert',
            rule: 'ci_failure',
            repo,
            event,
            name: node?.name ?? node?.head_branch ?? '',
            conclusion,
            branch: node?.head_branch,
            url: node?.html_url,
          },
          `FLEET-MEDIC: CI failure in ${repo} (${conclusion})`,
        );
        void postAlert(`🔴 **CI failure** — \`${repo}\` (${conclusion}) on \`${node?.head_branch ?? ''}\`. ${node?.html_url ?? ''}`);
      }
    }

    // ── Fleet-medic rule 2: autonomous coding-agent PR activity ───────────────
    if (event === 'pull_request' && (action === 'opened' || action === 'ready_for_review')) {
      const login = p.pull_request?.user?.login ?? '';
      if (/code-agent$|copilot/i.test(login)) {
        logger.info(
          {
            type: 'fleet_medic',
            rule: 'agent_pr',
            repo,
            pr: p.pull_request?.number,
            agent: login,
            title: p.pull_request?.title,
            url: p.pull_request?.html_url,
          },
          `FLEET-MEDIC: autonomous agent ${login} opened PR #${p.pull_request?.number} in ${repo}`,
        );
      }
    }

    return reply.code(200).send({ ok: true, event, recorded: true });
  });
}
