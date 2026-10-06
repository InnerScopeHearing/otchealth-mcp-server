import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  __resetRetractionCache,
  __setRetractionReadersForTests,
  __seedRetractionCacheForTests,
  getRetractionSnapshot,
  noteRetraction,
} from './retractions.js';

test('a healthy retraction snapshot returns complete status with its lane map', async () => {
  __setRetractionReadersForTests({
    shared: async () => [{ agent: 'cto', supersedes: 'from-shared' }],
    memory: async () => [{ agent: 'cfo', supersedes: 'from-memory' }],
  });
  try {
    const snapshot = await getRetractionSnapshot();
    assert.equal(snapshot.verified, true);
    assert.deepEqual([...snapshot.byAgent.get('cto') ?? []], ['from-shared']);
    assert.deepEqual([...snapshot.byAgent.get('cfo') ?? []], ['from-memory']);
  } finally {
    __resetRetractionCache();
  }
});

test('one failed source keeps the other source map and returns incomplete status', async () => {
  __setRetractionReadersForTests({
    shared: async () => { throw new Error('shared-provider-error-must-not-escape'); },
    memory: async () => [{ agent: 'cto', supersedes: 'locally-proven' }],
  });
  try {
    const snapshot = await getRetractionSnapshot();
    assert.equal(snapshot.verified, false);
    assert.deepEqual([...snapshot.byAgent.get('cto') ?? []], ['locally-proven']);
    assert.equal(JSON.stringify(snapshot).includes('shared-provider-error'), false);
  } finally {
    __resetRetractionCache();
  }
});

test('when both sources fail, empty data is still explicitly unverified', async () => {
  __setRetractionReadersForTests({
    shared: async () => { throw new Error('shared-provider-error-must-not-escape'); },
    memory: async () => { throw new Error('memory-provider-error-must-not-escape'); },
  });
  try {
    const snapshot = await getRetractionSnapshot();
    assert.equal(snapshot.verified, false);
    assert.equal(snapshot.byAgent.size, 0);
    assert.equal(JSON.stringify(snapshot).includes('provider-error'), false);
  } finally {
    __resetRetractionCache();
  }
});

test('a local retraction recorded during an expired-cache refresh survives its completion', async () => {
  let releaseShared!: (rows: Array<{ agent?: unknown; supersedes?: unknown }>) => void;
  const blockedShared = new Promise<Array<{ agent?: unknown; supersedes?: unknown }>>((resolve) => { releaseShared = resolve; });
  __setRetractionReadersForTests({ shared: async () => blockedShared, memory: async () => [] });
  __seedRetractionCacheForTests(new Map(), false, 120_001);
  try {
    const pending = getRetractionSnapshot();
    noteRetraction('cto', 'local-proof');
    releaseShared([]);
    const snapshot = await pending;
    assert.equal(snapshot.verified, true);
    assert.deepEqual([...snapshot.byAgent.get('cto') ?? []], ['local-proof']);
  } finally {
    __resetRetractionCache();
  }
});

test('concurrent snapshot readers observe matching map and verification state; returned maps are isolated', async () => {
  __seedRetractionCacheForTests(new Map([['cto', new Set(['proof'])]]), true);
  try {
    const [a, b] = await Promise.all([getRetractionSnapshot(), getRetractionSnapshot()]);
    assert.equal(a.verified, false);
    assert.equal(b.verified, false);
    assert.deepEqual([...a.byAgent.get('cto') ?? []], ['proof']);
    assert.deepEqual([...b.byAgent.get('cto') ?? []], ['proof']);
    a.byAgent.get('cto')?.clear();
    const c = await getRetractionSnapshot();
    assert.deepEqual([...c.byAgent.get('cto') ?? []], ['proof'], 'a caller cannot mutate the cached proof');
  } finally {
    __resetRetractionCache();
  }
});
