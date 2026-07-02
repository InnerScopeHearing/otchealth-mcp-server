import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSeriesPayload, llmMetricPoints } from './datadog-metrics.js';

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
