import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import Fastify from 'fastify';

process.env.CIO_SITE_ID = 'test';
process.env.CIO_TRACK_KEY = 'test';
process.env.CIO_APP_API_BEARER = 'test';
process.env.PERPLEXITY_CONNECTOR_TOKEN = 'x'.repeat(32);
process.env.ADMIN_REVOKE_TOKEN = 'x'.repeat(32);
process.env.N8N_WEBHOOK_SECRET = 'x'.repeat(32);
process.env.GITHUB_WEBHOOK_SECRET = 'synthetic-webhook-secret';
process.env.SNS_ALERT_TOPIC_ARN = 'arn:aws:sns:us-east-1:900915535335:otchealth-aws-alerts';
process.env.AWS_ACCESS_KEY_ID = 'synthetic-access-key';
process.env.AWS_SECRET_ACCESS_KEY = 'synthetic-secret-key';
delete process.env.AWS_SESSION_TOKEN;
delete process.env.GITHUB_APP_ID;
delete process.env.GITHUB_APP_PRIVATE_KEY;
delete process.env.GITHUB_APP_INSTALLATION_ID;

const { registerWebhookRoutes } = await import('./webhooks.js');

test('signed GitHub webhook routing sends one alert per Actions run and retains third-party suites', async () => {
  const app = Fastify();
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (request, body, done) => {
    (request as typeof request & { rawBody: string }).rawBody = body as string;
    done(null, JSON.parse(body as string));
  });
  registerWebhookRoutes(app);

  const originalFetch = globalThis.fetch;
  const published: string[] = [];
  globalThis.fetch = (async (url: unknown, options?: RequestInit) => {
    assert.equal(String(url), 'https://sns.us-east-1.amazonaws.com/');
    published.push(new URLSearchParams(String(options?.body)).get('Message') ?? '');
    return new Response('<PublishResponse/>', { status: 200 });
  }) as typeof fetch;

  async function deliver(event: 'workflow_run' | 'check_suite', id: number, provider?: string, valid = true) {
    const payload = JSON.stringify({
      action: 'completed',
      repository: { full_name: 'InnerScopeHearing/otchealth-claude-tools' },
      [event]: {
        id,
        conclusion: 'failure',
        head_branch: 'main',
        head_sha: 'same-commit',
        ...(event === 'workflow_run'
          ? { name: `workflow-${id}`, html_url: `https://github.com/InnerScopeHearing/otchealth-claude-tools/actions/runs/${id}` }
          : { app: { slug: provider } }),
      },
    });
    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/github',
      headers: {
        'content-type': 'application/json',
        'x-github-event': event,
        'x-hub-signature-256': valid
          ? `sha256=${crypto.createHmac('sha256', 'synthetic-webhook-secret').update(payload).digest('hex')}`
          : 'sha256=invalid',
      },
      payload,
    });
    // Alert delivery is intentionally detached from the webhook response.
    await setImmediate();
    return response;
  }

  try {
    assert.equal((await deliver('workflow_run', 1)).statusCode, 200);
    assert.equal((await deliver('check_suite', 10, 'github-actions')).statusCode, 200);
    assert.equal(published.length, 1);
    assert.match(published[0], /actions\/runs\/1/);

    await deliver('workflow_run', 2);
    assert.equal(published.length, 2, 'separate workflow on the same commit remains visible');
    await deliver('check_suite', 20, 'third-party-ci');
    assert.equal(published.length, 3, 'third-party check suite remains visible');

    assert.equal((await deliver('workflow_run', 3, undefined, false)).statusCode, 401);
    assert.equal(published.length, 3, 'an invalid signature cannot emit an alert');
  } finally {
    globalThis.fetch = originalFetch;
    await app.close();
  }
});
