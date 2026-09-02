import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSeriesPayload, llmMetricPoints, openAIUsageMetricPoints } from './datadog-metrics.js';

test('llmMetricPoints: emits the 3 metrics with model/task tags and correct types', () => {
  const pts = llmMetricPoints('gpt-5.1', 'summarize', { prompt_tokens: 1132, cached_tokens: 1024, cached_pct: 90.5 });
  const byName = Object.fromEntries(pts.map((p) => [p.metric, p]));
  assert.equal(byName['otc.gateway.llm.prompt_tokens'].value, 1132);
  assert.equal(byName['otc.gateway.llm.prompt_tokens'].type, 1); // count
  assert.equal(byName['otc.gateway.llm.cached_tokens'].value, 1024);
  assert.equal(byName['otc.gateway.llm.cached_pct'].value, 90.5);
  assert.equal(byName['otc.gateway.llm.cached_pct'].type, 3); // gauge
  for (const p of pts) {
    assert.ok(p.tags?.includes('model:gpt-5.1'));
    assert.ok(p.tags?.includes('task:summarize'));
    assert.ok(p.tags?.includes('service:gateway-mcp'));
  }
});

test('llmMetricPoints: defaults empty model/task to "unknown"', () => {
  const pts = llmMetricPoints('', '', { prompt_tokens: 0, cached_tokens: 0, cached_pct: 0 });
  assert.ok(pts[0].tags?.includes('model:unknown'));
  assert.ok(pts[0].tags?.includes('task:unknown'));
});

test('buildSeriesPayload: wraps points, defaults gauge, stamps the timestamp', () => {
  const body = buildSeriesPayload([{ metric: 'otc.gateway.llm.cached_pct', value: 90.5 }], 1750000000);
  assert.ok(body);
  assert.equal(body!.series.length, 1);
  assert.equal(body!.series[0].type, 3);
  assert.equal(body!.series[0].points[0].timestamp, 1750000000);
  assert.equal(body!.series[0].points[0].value, 90.5);
});

test('buildSeriesPayload: drops non-finite values and returns null when nothing finite remains', () => {
  const body = buildSeriesPayload([
    { metric: 'a', value: Number.NaN },
    { metric: 'b', value: Infinity },
    { metric: 'c', value: 5 },
  ]);
  assert.equal(body!.series.length, 1);
  assert.equal(body!.series[0].metric, 'c');
  assert.equal(buildSeriesPayload([{ metric: 'a', value: Number.NaN }]), null);
  assert.equal(buildSeriesPayload([]), null);
});

// openAIUsageMetricPoints -- the otc.fleet.openai.* fleet-wide points, SAME metric names/tag shape
// as otchealth-claude-tools/setup/openai-usage.mjs (see that file's own tests for the toolkit side
// of this contract, and docs/OPENAI-COST-VISIBILITY.md for why the two repos share names but not code).

test('openAIUsageMetricPoints: emits tokens (input+output), requests, and cost_usd_est with the shared tag shape', () => {
  const pts = openAIUsageMetricPoints({
    model: 'gpt-4o',
    kind: 'chat',
    caller: 'gateway-chat',
    unknown: false,
    promptTokens: 100,
    completionTokens: 50,
    costUsd: 0.0025,
  });
  const tokenPts = pts.filter((p) => p.metric === 'otc.fleet.openai.tokens');
  const inputPt = tokenPts.find((p) => p.tags?.includes('direction:input'));
  const outputPt = tokenPts.find((p) => p.tags?.includes('direction:output'));
  assert.equal(inputPt?.value, 100);
  assert.equal(outputPt?.value, 50);
  assert.equal(inputPt?.type, 1); // count
  const requestsPt = pts.find((p) => p.metric === 'otc.fleet.openai.requests');
  assert.equal(requestsPt?.value, 1);
  const costPt = pts.find((p) => p.metric === 'otc.fleet.openai.cost_usd_est');
  assert.equal(costPt?.value, 0.0025);
  assert.equal(costPt?.type, 1); // count
  for (const p of pts) {
    assert.ok(p.tags?.includes('model:gpt-4o'));
    assert.ok(p.tags?.includes('kind:chat'));
    assert.ok(p.tags?.includes('caller:gateway-chat'));
    assert.ok(p.tags?.includes('repo:otchealth-mcp-server'), 'defaults repo to this gateway when unset');
    assert.ok(p.tags?.includes('unknown:false'));
  }
});

test('openAIUsageMetricPoints: an embedding call (completionTokens 0) does NOT emit a spurious direction:output tokens point', () => {
  const pts = openAIUsageMetricPoints({
    model: 'text-embedding-3-large',
    kind: 'embedding',
    caller: 'gateway-embed',
    unknown: false,
    promptTokens: 500,
    completionTokens: 0,
    costUsd: 0.000065,
  });
  const outputPts = pts.filter((p) => p.metric === 'otc.fleet.openai.tokens' && p.tags?.includes('direction:output'));
  assert.equal(outputPts.length, 0);
  const inputPts = pts.filter((p) => p.metric === 'otc.fleet.openai.tokens' && p.tags?.includes('direction:input'));
  assert.equal(inputPts.length, 1);
});

test('openAIUsageMetricPoints: unknown:true is tagged as a literal string, not a boolean, so a Datadog tag query can match on it', () => {
  const pts = openAIUsageMetricPoints({
    model: 'some-future-model',
    kind: 'other',
    caller: 'test',
    unknown: true,
    promptTokens: 10,
    completionTokens: 10,
    costUsd: 1,
  });
  assert.ok(pts.every((p) => p.tags?.includes('unknown:true')));
});

test('openAIUsageMetricPoints -> buildSeriesPayload composes cleanly into a real v2/series body', () => {
  const pts = openAIUsageMetricPoints({
    model: 'gpt-4o',
    kind: 'chat',
    caller: 'gateway-chat',
    unknown: false,
    promptTokens: 10,
    completionTokens: 5,
    costUsd: 0.0001,
  });
  const body = buildSeriesPayload(pts);
  assert.ok(body);
  const names = body!.series.map((s) => s.metric);
  assert.ok(names.includes('otc.fleet.openai.tokens'));
  assert.ok(names.includes('otc.fleet.openai.requests'));
  assert.ok(names.includes('otc.fleet.openai.cost_usd_est'));
});
