import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * postAlert()'s SNS fallback (2026-08-28) -- SNS_ALERT_TOPIC_ARN CONFIGURED scenario.
 *
 * webhooks.ts had no test coverage of any kind before this file. `env.SNS_ALERT_TOPIC_ARN` (like
 * every other env.ts field) is read through loadEnv(), which memoizes for the life of the PROCESS
 * (see config/env.ts's `cached`), so it must be fixed here, once, before the first dynamic import
 * below, and cannot vary test-to-test WITHIN this file -- the same reasoning
 * agentstate/queue-postgres.test.ts's own header documents for PG_HOST. The "SNS_ALERT_TOPIC_ARN is
 * UNSET" scenario therefore needs its own process: see webhooks-sns-unconfigured.test.ts.
 *
 * GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY / GITHUB_APP_INSTALLATION_ID are deliberately left UNSET.
 * github/api-client.ts's getInstallationToken() checks GITHUB_APP_INSTALLATION_ID first and throws
 * `GitHubApiError({code:'github_not_configured', ...})` synchronously, before githubSend() ever
 * calls fetchWithBudget() -- so createIssueComment() fails with ZERO real network activity, which is
 * a faithful trigger for postAlert's catch block (it treats every failure identically; nothing here
 * depends on the failure being specifically a GitHub 403) and far simpler to set up deterministically
 * than mocking the App's JWT-mint + installation-token exchange just to force one.
 */

process.env.CIO_SITE_ID ||= 'test';
process.env.CIO_TRACK_KEY ||= 'test';
process.env.CIO_APP_API_BEARER ||= 'test';
process.env.PERPLEXITY_CONNECTOR_TOKEN ||= 'x'.repeat(32);
process.env.ADMIN_REVOKE_TOKEN ||= 'x'.repeat(32);
process.env.N8N_WEBHOOK_SECRET ||= 'x'.repeat(32);
delete process.env.GITHUB_APP_ID;
delete process.env.GITHUB_APP_PRIVATE_KEY;
delete process.env.GITHUB_APP_INSTALLATION_ID;
// FLEET_MEDIC_LOG_REPO / FLEET_MEDIC_LOG_ISSUE are left at env.ts's own schema defaults (a real,
// non-empty repo + issue number), so postAlert's `if (!target || !issue) return` guard never
// short-circuits before reaching createIssueComment -- exactly the branch under test here.
process.env.SNS_ALERT_TOPIC_ARN ||= 'arn:aws:sns:us-east-1:900915535335:otchealth-aws-alerts';

const { postAlert } = await import('./webhooks.js');

// AWS credentials, unlike everything above, are read FRESH on every call by
// search/sigv4.ts's resolveAwsCredentials() (plain process.env reads, no loadEnv() involved) -- so
// these, and the fetch mock, CAN vary test-to-test within this one file.
const originalFetch = globalThis.fetch;
const AWS_KEYS = [
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
  'AWS_CONTAINER_CREDENTIALS_FULL_URI',
] as const;
const originalAws: Record<string, string | undefined> = {};
for (const k of AWS_KEYS) originalAws[k] = process.env[k];

function resetEnvAndFetch(): void {
  globalThis.fetch = originalFetch;
  for (const k of AWS_KEYS) {
    if (originalAws[k] === undefined) delete process.env[k];
    else process.env[k] = originalAws[k];
  }
}

test('postAlert: createIssueComment failing + SNS configured + AWS credentials present -> attempts a SigV4-signed SNS Publish, and still resolves without throwing', async () => {
  for (const k of AWS_KEYS) delete process.env[k];
  process.env.AWS_ACCESS_KEY_ID = 'fake-access-key-id';
  process.env.AWS_SECRET_ACCESS_KEY = 'fake-secret-access-key';
  let calledUrl: string | undefined;
  let calledMethod: string | undefined;
  let calledBody: string | undefined;
  let calledContentType: string | undefined;
  let sawAuthHeader = false;
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    calledUrl = String(url);
    calledMethod = init?.method;
    calledBody = init?.body as string | undefined;
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calledContentType = headers['content-type'];
    sawAuthHeader = typeof headers.Authorization === 'string' && headers.Authorization.startsWith('AWS4-HMAC-SHA256');
    return new Response('<PublishResponse/>', { status: 200 });
  }) as typeof fetch;
  try {
    await assert.doesNotReject(() => postAlert('🔴 test alert body'));
    assert.equal(calledUrl, 'https://sns.us-east-1.amazonaws.com/');
    assert.equal(calledMethod, 'POST');
    assert.match(calledBody ?? '', /Action=Publish/);
    assert.match(calledBody ?? '', /Version=2010-03-31/);
    assert.match(calledBody ?? '', /TopicArn=arn%3Aaws%3Asns%3Aus-east-1%3A900915535335%3Aotchealth-aws-alerts/);
    assert.equal(calledContentType, 'application/x-www-form-urlencoded');
    assert.ok(sawAuthHeader, 'expected a SigV4 Authorization header on the SNS publish request');
  } finally {
    resetEnvAndFetch();
  }
});

test('postAlert: never throws even when the SNS publish itself gets a non-2xx response (e.g. a bad/expired credential)', async () => {
  for (const k of AWS_KEYS) delete process.env[k];
  process.env.AWS_ACCESS_KEY_ID = 'fake-access-key-id';
  process.env.AWS_SECRET_ACCESS_KEY = 'fake-secret-access-key';
  globalThis.fetch = (async () => new Response('<ErrorResponse/>', { status: 403 })) as typeof fetch;
  try {
    await assert.doesNotReject(() => postAlert('test alert body'));
  } finally {
    resetEnvAndFetch();
  }
});

test('postAlert: never throws even when the SNS publish request itself throws (network error) -- alerting must never break webhook ingestion', async () => {
  for (const k of AWS_KEYS) delete process.env[k];
  process.env.AWS_ACCESS_KEY_ID = 'fake-access-key-id';
  process.env.AWS_SECRET_ACCESS_KEY = 'fake-secret-access-key';
  globalThis.fetch = (async () => {
    throw new Error('ECONNREFUSED');
  }) as typeof fetch;
  try {
    await assert.doesNotReject(() => postAlert('test alert body'));
  } finally {
    resetEnvAndFetch();
  }
});

test('postAlert: SNS_ALERT_TOPIC_ARN configured but no AWS credentials resolve -> skips the publish attempt entirely, still never throws', async () => {
  for (const k of AWS_KEYS) delete process.env[k];
  let fetchCalled = false;
  globalThis.fetch = (async () => {
    fetchCalled = true;
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
  try {
    await assert.doesNotReject(() => postAlert('test alert body'));
    assert.equal(fetchCalled, false, 'must not attempt an SNS publish with no resolvable AWS credentials');
  } finally {
    resetEnvAndFetch();
  }
});
