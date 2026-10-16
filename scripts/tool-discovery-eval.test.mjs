import test from 'node:test';
import assert from 'node:assert/strict';
import fixture from '../fixtures/tool-discovery-eval.json' with { type: 'json' };
import { evaluateDiscovery } from './tool-discovery-eval.mjs';

test('fixed routes are checked against the real bounded discovery helper', () => {
  const report = evaluateDiscovery(fixture);
  assert.equal(report.routeCount, fixture.routes.length);
  assert.equal(report.successCount, fixture.routes.length);
  assert.equal(report.actualToolDefinitionTokens, null);
  assert.equal(report.claimedHostContextSaving, null);
  assert.equal(report.llmRoutingAccuracy, null);
  assert.equal(report.helperToolExecutions, 0);
  assert.ok(report.metadata.fullCatalogChars > 0);
  assert.ok(report.metadata.fullCatalogUtf8Bytes >= report.metadata.fullCatalogChars);
  assert.equal(report.metadata.helperSampleCount, fixture.routes.length + 1);
  assert.ok(Number.isFinite(report.metadata.meanHelperMs));
  assert.equal(report.routes.find(({ id }) => id === 'aws-pack-later-result').retryUsed, true);
  assert.deepEqual(report.routes.find(({ id }) => id === 'honest-empty-missing-tool').selected, []);
  assert.deepEqual(report.routes.find(({ id }) => id === 'out-of-supplied-scope').selected, []);
});

test('missing-tool expectations fail if any unexpected tool is returned', () => {
  const report = evaluateDiscovery({
    tools: [{ name: 'unexpected_write', description: 'missing tool' }],
    routes: [{ id: 'missing', query: 'missing tool', expected: null }],
    limits: { descriptionCharacters: 160 },
  });
  assert.equal(report.successCount, 0);
  assert.equal(report.failureCount, 1);
  assert.equal(report.routes[0].initialContainsExpected, false);
  assert.equal(report.routes[0].checks.expectedRoute, false);
});
