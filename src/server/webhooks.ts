import crypto from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { loadEnv } from '../config/env.js';
import { logger } from '../audit/logger.js';
import { getPullRequest, mergePullRequest, createIssueComment } from '../github/api-client.js';
import { resolveAwsCredentials, signRequest } from '../search/sigv4.js';

const env = loadEnv();

/** Extract the region embedded in an SNS topic ARN (`arn:aws:sns:{region}:{account}:{name}`), so
 *  the fallback below needs no separate region config -- the ARN is self-describing. Returns null
 *  for a malformed value so the caller can skip rather than sign a request against a wrong host. */
function snsRegionFromArn(arn: string): string | null {
  const m = /^arn:aws:sns:([a-z0-9-]+):\d+:.+$/.exec(arn);
  return m ? m[1] : null;
}

/**
 * SNS-publish fallback for postAlert(), added 2026-08-28. Fires ONLY from postAlert's catch block,
 * i.e. only when createIssueComment() ITSELF fails (the exact failure mode that made every
 * CI-failure/auto-merge alert since ~2026-08-10 vanish silently once issue #21 hit GitHub's hard
 * 2500-comment cap) -- and only when SNS_ALERT_TOPIC_ARN is configured; inert otherwise. NEVER
 * throws: an alerting path that can itself take down webhook ingestion would be worse than the
 * silent-drop bug it exists to fix, so every failure mode here is a warn-log, not a rejection.
 * Fans out through the already-deployed 4-channel otchealth-aws-alert-fanout Lambda (GitHub issue
 * #226 + Datadog + PostHog + Graph email; see infra-aws/alert-fanout-lambda/README.md), so a
 * capped/renamed/deleted GitHub issue can never again silently eat every fleet-medic alert -- this
 * does NOT replace the issue-comment route (still the primary, human-readable channel), only
 * backstops its failure.
 */
async function publishToSnsFallback(message: string): Promise<void> {
  const topicArn = env.SNS_ALERT_TOPIC_ARN;
  if (!topicArn) return;
  const region = snsRegionFromArn(topicArn);
  if (!region) {
    logger.warn(
      { type: 'fleet_medic_sns_fallback_failed', reason: 'malformed_topic_arn' },
      'SNS_ALERT_TOPIC_ARN is not a valid SNS topic ARN, skipping the alert fallback',
    );
    return;
  }
  try {
    const credentials = await resolveAwsCredentials();
    if (!credentials) {
      logger.warn(
        { type: 'fleet_medic_sns_fallback_failed', reason: 'no_aws_credentials' },
        'could not resolve AWS credentials for the SNS alert fallback',
      );
      return;
    }
    const host = `sns.${region}.amazonaws.com`;
    // SNS's query-protocol Publish action: parameters as a form-encoded POST body, not a query
    // string. TopicArn/Message are sent verbatim; URLSearchParams handles the encoding.
    const body = new URLSearchParams({
      Action: 'Publish',
      Version: '2010-03-31',
      TopicArn: topicArn,
      Message: message,
    }).toString();
    const signed = signRequest({
      method: 'POST',
      host,
      path: '/',
      body,
      region,
      service: 'sns',
      credentials,
      extraHeaders: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    const res = await fetch(`https://${host}/`, {
      method: 'POST',
      headers: signed.headers,
      body,
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      logger.warn(
        { type: 'fleet_medic_sns_fallback_failed', reason: 'sns_non_2xx', status: res.status },
        'SNS publish for the fleet-medic alert fallback returned a non-2xx status',
      );
    }
  } catch (e) {
    logger.warn(
      { type: 'fleet_medic_sns_fallback_failed', reason: 'exception', error: (e as Error).message },
      'SNS publish for the fleet-medic alert fallback threw',
    );
  }
}

/** Route a fleet-medic alert to the central, human+agent-visible log issue (App token). Exported
 *  (2026-08-28) so webhooks.test.ts can drive the SNS fallback directly -- this file had no test
 *  coverage at all before that PR; see that file's header for why the failure trigger it uses is
 *  "GitHub App not configured" rather than a mocked 403 from GitHub itself. */
export async function postAlert(body: string): Promise<void> {
  const target = env.FLEET_MEDIC_LOG_REPO;
  const issue = parseInt(env.FLEET_MEDIC_LOG_ISSUE || '0', 10);
  if (!target || !issue) return;
  const [owner, repo] = target.split('/');
  if (!owner || !repo) return;
  try {
    await createIssueComment(owner, repo, issue, body);
  } catch (e) {
    logger.warn({ type: 'fleet_medic_alert_route_failed', error: (e as Error).message }, 'could not post fleet-medic alert to log issue');
    await publishToSnsFallback(body);
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
