import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * postAlert()'s SNS fallback (2026-08-28) -- SNS_ALERT_TOPIC_ARN UNSET scenario.
 *
 * Own file / own `node --test` child process, deliberately: see webhooks.test.ts's header for why
 * `env.SNS_ALERT_TOPIC_ARN` cannot vary between "configured" and "unset" within one file (loadEnv()
 * memoizes per-process). This file proves the design's other required case: with the fallback
 * unconfigured, postAlert must still resolve without throwing and must never attempt a publish.
 *
 * GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY / GITHUB_APP_INSTALLATION_ID are deliberately left UNSET
 * for the same reason as webhooks.test.ts: createIssueComment() then fails immediately with zero
 * real network activity, a faithful (and far simpler to construct) trigger for postAlert's catch
 * block than mocking a real GitHub 403.
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
delete process.env.SNS_ALERT_TOPIC_ARN;

const { postAlert } = await import('./webhooks.js');

test('postAlert: createIssueComment failing + SNS_ALERT_TOPIC_ARN unset -> resolves without throwing and never touches fetch (warn-log only)', async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalled = false;
  globalThis.fetch = (async () => {
    fetchCalled = true;
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
  try {
    await assert.doesNotReject(() => postAlert('test alert body'));
    assert.equal(fetchCalled, false, 'the SNS fallback must be a complete no-op when SNS_ALERT_TOPIC_ARN is unset');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
