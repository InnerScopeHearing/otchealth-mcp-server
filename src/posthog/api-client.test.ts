import '../test-helpers/env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  listProjects,
  listInsights,
  listCohorts,
  PostHogApiError,
} from './api-client.js';

// POSTHOG_PERSONAL_API_KEY is intentionally unset in the test env.

test('posthog client throws posthog_not_configured when the key is unset', async () => {
  await assert.rejects(
    () => listProjects(),
    (err: unknown) => {
      assert.ok(err instanceof PostHogApiError);
      assert.equal((err as PostHogApiError).code, 'posthog_not_configured');
      assert.match((err as PostHogApiError).nextStep, /POSTHOG_PERSONAL_API_KEY/);
      return true;
    },
  );
});

test('posthog project-scoped reads also reject cleanly when unconfigured', async () => {
  await assert.rejects(() => listInsights(468389), (err: unknown) => err instanceof PostHogApiError);
  await assert.rejects(() => listCohorts(468389), (err: unknown) => err instanceof PostHogApiError);
});

test('posthog rejects an injection-y path-segment id (request-forgery guard)', async () => {
  // A crafted id must be rejected by seg() BEFORE any request is built.
  await assert.rejects(
    () => listInsights('1/../../session_recordings'),
    (err: unknown) => err instanceof PostHogApiError && (err as PostHogApiError).code === 'posthog_invalid_id',
  );
  await assert.rejects(
    () => listInsights('1?evil=1'),
    (err: unknown) => err instanceof PostHogApiError && (err as PostHogApiError).code === 'posthog_invalid_id',
  );
});

test('posthog accepts a clean numeric id (passes seg, then hits not-configured)', async () => {
  await assert.rejects(
    () => listInsights(468389),
    (err: unknown) => err instanceof PostHogApiError && (err as PostHogApiError).code === 'posthog_not_configured',
  );
});

test('posthog client module does not export any replay/recording/person reader (PHI carve-out)', async () => {
  const mod = (await import('./api-client.js')) as Record<string, unknown>;
  const exportNames = Object.keys(mod).map((n) => n.toLowerCase());
  const banned = ['recording', 'replay', 'session', 'person', 'events', 'query'];
  for (const name of exportNames) {
    for (const b of banned) {
      assert.ok(
        !name.includes(b),
        `PHI carve-out violated: posthog api-client exports "${name}" which matches banned token "${b}"`,
      );
    }
  }
});
