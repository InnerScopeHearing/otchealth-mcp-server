import test from 'node:test';
import assert from 'node:assert/strict';
import { runCloudBrowserPolling } from './cloud-browser-runtime.js';
import { initializeStartup, startPostListenWorkers } from './startup-coordinator.js';

const ready = { static_token_auth_ready: true, state: 'ready' };

test('canary initializes revocations but calls no reloaders or browser worker', async () => {
  const calls: string[] = [];
  const state = await initializeStartup(
    { CANARY_MODE: true },
    {
      loadRevocations: async () => { calls.push('load'); return 2; },
      getRevocationStoreStatus: () => ready,
      startRevocationReloader: () => calls.push('revocation-reloader'),
      startDeindexResweepReloader: () => calls.push('deindex-reloader'),
      runCloudBrowserPolling: () => { calls.push('browser-worker'); return () => undefined; },
    },
  );
  const stop = startPostListenWorkers({ CANARY_MODE: true }, {
    runCloudBrowserPolling: (canary) => { calls.push(`browser:${canary}`); return () => undefined; },
  });
  stop();
  assert.deepEqual(state, { revokedCount: 2, revocationStatus: ready });
  assert.deepEqual(calls, ['load', 'browser:true']);
});

test('canary rejects unready auth before any reloader or listener stage', async () => {
  const calls: string[] = [];
  await assert.rejects(
    initializeStartup(
      { CANARY_MODE: true },
      {
        loadRevocations: async () => { calls.push('load'); return 0; },
        getRevocationStoreStatus: () => ({ static_token_auth_ready: false, state: 'unavailable' }),
        startRevocationReloader: () => calls.push('revocation-reloader'),
        startDeindexResweepReloader: () => calls.push('deindex-reloader'),
        runCloudBrowserPolling: () => { calls.push('browser-worker'); return () => undefined; },
      },
    ),
    /canary_auth_not_ready/,
  );
  assert.deepEqual(calls, ['load']);
});

test('production initializes revocations and starts both reloaders and browser stage', async () => {
  const calls: string[] = [];
  await initializeStartup(
    { CANARY_MODE: false },
    {
      loadRevocations: async () => { calls.push('load'); return 1; },
      getRevocationStoreStatus: () => ready,
      startRevocationReloader: () => calls.push('revocation-reloader'),
      startDeindexResweepReloader: () => calls.push('deindex-reloader'),
      runCloudBrowserPolling: () => { calls.push('browser-worker'); return () => undefined; },
    },
  );
  startPostListenWorkers({ CANARY_MODE: false }, {
    runCloudBrowserPolling: (canary) => { calls.push(`browser:${canary}`); return () => undefined; },
  });
  assert.deepEqual(calls, ['load', 'revocation-reloader', 'deindex-reloader', 'browser:false']);
});

test('canary runtime never starts the cloud-browser poller even when enabled', () => {
  const original = process.env.CLOUD_BROWSER_WORKER_ENABLED;
  process.env.CLOUD_BROWSER_WORKER_ENABLED = 'true';
  try {
    assert.doesNotThrow(() => runCloudBrowserPolling(true));
  } finally {
    if (original === undefined) delete process.env.CLOUD_BROWSER_WORKER_ENABLED;
    else process.env.CLOUD_BROWSER_WORKER_ENABLED = original;
  }
});

test('production runtime retains the existing cloud-browser gate', () => {
  const original = process.env.CLOUD_BROWSER_WORKER_ENABLED;
  delete process.env.CLOUD_BROWSER_WORKER_ENABLED;
  try {
    assert.doesNotThrow(() => runCloudBrowserPolling(false));
  } finally {
    if (original === undefined) delete process.env.CLOUD_BROWSER_WORKER_ENABLED;
    else process.env.CLOUD_BROWSER_WORKER_ENABLED = original;
  }
});

