import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  __resetRetractionCache,
  __setRetractionReadersForTests,
  __seedRetractionCacheForTests,
  getRetractionSnapshot,
  getRetractionAuthorityDiagnostic,
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

test('malformed successful source rows are incomplete, not verified', async () => {
  __setRetractionReadersForTests({
    shared: async () => [{ agent: 'cto', supersedes: 42 }],
    memory: async () => [],
  });
  try {
    const snapshot = await getRetractionSnapshot();
    assert.equal(snapshot.verified, false);
  } finally {
    __resetRetractionCache();
  }
});

test('an unowned shared declared retraction is incomplete, while ordinary unowned rows remain valid', async () => {
  __setRetractionReadersForTests({
    shared: async () => [{ supersedes: 'unowned-retraction' }],
    memory: async () => [],
  });
  try {
    const snapshot = await getRetractionSnapshot();
    assert.equal(snapshot.verified, false);
  } finally {
    __resetRetractionCache();
  }

  __setRetractionReadersForTests({
    shared: async () => [{ text: 'ordinary shared note' }],
    memory: async () => [],
  });
  try {
    const snapshot = await getRetractionSnapshot();
    assert.equal(snapshot.verified, true);
  } finally {
    __resetRetractionCache();
  }
});

test('a bounded memory projection at its page limit is not claimed complete', async () => {
  __setRetractionReadersForTests({
    shared: async () => [],
    memory: async () => Array.from({ length: 5000 }, (_, i) => ({ agent: 'cto', supersedes: `row-${i}` })),
  });
  try {
    const snapshot = await getRetractionSnapshot();
    assert.equal(snapshot.verified, false);
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

test('a local proof survives a refresh that began with a cold cache', async () => {
  let release!: (rows: Array<{ agent?: unknown; supersedes?: unknown }>) => void;
  const blocked = new Promise<Array<{ agent?: unknown; supersedes?: unknown }>>(resolve => { release = resolve; });
  __setRetractionReadersForTests({ shared: async () => blocked, memory: async () => [] });
  try {
    const pending = getRetractionSnapshot();
    noteRetraction('cto', 'cto__cold-proof');
    release([]);
    const snapshot = await pending;
    assert.equal(snapshot.verified, true);
    assert.equal(snapshot.byAgent.get('cto')?.has('cold-proof'), true);
  } finally { __resetRetractionCache(); }
});

test('diagnostic reports both source statuses and bounded cache age without rows', async () => {
  __setRetractionReadersForTests({
    shared: async () => [{ agent: 'cto', supersedes: 'hidden-shared-id' }],
    memory: async () => [{ agent: 'cto', supersedes: 'hidden-memory-id' }],
  });
  try {
    const diagnostic = await getRetractionAuthorityDiagnostic();
    assert.deepEqual(diagnostic.schema, 'retraction-authority-diagnostic.v1');
    assert.equal(diagnostic.shared_source, 'healthy');
    assert.equal(diagnostic.memory_source, 'healthy');
    assert.equal(diagnostic.verified, true);
    assert.equal(typeof diagnostic.cache_age_ms, 'number');
    assert.ok((diagnostic.cache_age_ms ?? -1) >= 0);
    assert.equal(JSON.stringify(diagnostic).includes('hidden-'), false);
  } finally {
    __resetRetractionCache();
  }
});

test('diagnostic preserves partial-source failure and does not expose the exception', async () => {
  __setRetractionReadersForTests({
    shared: async () => { throw new Error('secret-endpoint-value'); },
    memory: async () => [],
  });
  try {
    const diagnostic = await getRetractionAuthorityDiagnostic();
    assert.equal(diagnostic.shared_source, 'error');
    assert.equal(diagnostic.memory_source, 'healthy');
    assert.equal(diagnostic.verified, false);
    assert.equal(JSON.stringify(diagnostic).includes('secret-endpoint-value'), false);
  } finally {
    __resetRetractionCache();
  }
});
