import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildLlmObsSpan, buildLlmObsPayload, emitLlmObsSpan, generateSpanId, nowNs } from './llmobs.js';

const ENV_KEYS = ['DD_LLMOBS_ENABLED', 'DD_LLMOBS_CAPTURE_CONTENT', 'DD_LLMOBS_ML_APP', 'DD_API_KEY', 'DD_METRICS_API_KEY', 'DD_SITE'];

/** Clears every env var this module reads, then applies `overrides`, restoring the original
 *  values afterward regardless of outcome. Mirrors the withStubbedFetch/env pattern already
 *  established in this repo's other fetch-touching test suites (e.g. the toolkit's
 *  tests/bedrock-client.test.mjs) so every test is deterministic regardless of ambient
 *  session-hydrated secrets (a real DD_API_KEY could otherwise be present in an interactive
 *  session, exactly the hazard run-tests.sh's OPENAI_USAGE_DISABLE precedent guards against). */
function withEnv(overrides: Record<string, string | undefined>, fn: () => void): void {
  const saved: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  for (const k of ENV_KEYS) delete process.env[k];
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    fn();
  } finally {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

function withStubbedFetch(stub: typeof fetch, fn: () => void): void {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    fn();
  } finally {
    globalThis.fetch = original;
  }
}

test('generateSpanId: 16 lowercase hex characters, not constant', () => {
  const id = generateSpanId();
  assert.match(id, /^[0-9a-f]{16}$/);
  assert.notEqual(id, generateSpanId());
});

test('nowNs: millisecond-scaled nanoseconds (Date.now() * 1e6)', () => {
  const before = Date.now() * 1e6;
  const n = nowNs();
  const after = Date.now() * 1e6;
  assert.ok(n >= before && n <= after, 'nowNs must fall within a Date.now()*1e6 window taken around the call');
});

// ---------------------------------------------------------------------------------------------
// Payload shape (buildLlmObsSpan / buildLlmObsPayload) -- pure, no env/network involved except
// where a test explicitly names DD_LLMOBS_CAPTURE_CONTENT (buildLlmObsSpan reads that one flag
// directly; it does not touch DD_LLMOBS_ENABLED, which only gates emitLlmObsSpan's network call).
// ---------------------------------------------------------------------------------------------

test('buildLlmObsSpan: an ok span carries ids/name/timing/kind/model/provider/tokens, no error', () => {
  const span = buildLlmObsSpan(
    {
      name: 'bedrock.converse',
      kind: 'llm',
      startNs: 1_000_000_000,
      durationNs: 500_000_000,
      ok: true,
      model: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
      provider: 'bedrock',
      inputTokens: 120,
      outputTokens: 40,
      metadata: { stop_reason: 'tool_use' },
    },
    { spanId: 'aaaa000000000000', traceId: 'bbbb000000000000' },
  );
  assert.equal(span.span_id, 'aaaa000000000000');
  assert.equal(span.trace_id, 'bbbb000000000000');
  assert.equal(span.parent_id, 'undefined');
  assert.equal(span.name, 'bedrock.converse');
  assert.equal(span.start_ns, 1_000_000_000);
  assert.equal(span.duration, 500_000_000);
  assert.equal(span.status, 'ok');
  const meta = span.meta as Record<string, unknown>;
  assert.equal(meta.kind, 'llm');
  assert.equal(meta.model_name, 'us.anthropic.claude-sonnet-4-5-20250929-v1:0');
  assert.equal(meta.model_provider, 'bedrock');
  assert.deepEqual(meta.metadata, { stop_reason: 'tool_use' });
  assert.equal(meta.error, undefined, 'no error field on a successful span');
  const metrics = span.metrics as Record<string, number>;
  assert.equal(metrics.input_tokens, 120);
  assert.equal(metrics.output_tokens, 40);
  assert.equal(metrics.total_tokens, 160, 'total_tokens derives from input+output when not supplied');
});

test('buildLlmObsSpan: content-off DEFAULT -- inputText/outputText never appear when DD_LLMOBS_CAPTURE_CONTENT is unset', () => {
  withEnv({}, () => {
    const span = buildLlmObsSpan(
      { name: 'x', kind: 'llm', startNs: 0, durationNs: 0, ok: true, inputText: 'super secret prompt', outputText: 'super secret completion' },
      { spanId: 's', traceId: 't' },
    );
    const meta = span.meta as Record<string, unknown>;
    assert.equal(meta.input, undefined, 'content must not leak by default');
    assert.equal(meta.output, undefined, 'content must not leak by default');
  });
});

test('buildLlmObsSpan: content-off holds for an explicit falsy DD_LLMOBS_CAPTURE_CONTENT value too', () => {
  withEnv({ DD_LLMOBS_CAPTURE_CONTENT: 'false' }, () => {
    const span = buildLlmObsSpan({ name: 'x', kind: 'llm', startNs: 0, durationNs: 0, ok: true, inputText: 'secret' }, { spanId: 's', traceId: 't' });
    assert.equal((span.meta as Record<string, unknown>).input, undefined);
  });
});

test('buildLlmObsSpan: DD_LLMOBS_CAPTURE_CONTENT=1 opts caller-supplied content IN, bounded to 4000 chars', () => {
  withEnv({ DD_LLMOBS_CAPTURE_CONTENT: '1' }, () => {
    const span = buildLlmObsSpan(
      { name: 'x', kind: 'llm', startNs: 0, durationNs: 0, ok: true, inputText: 'a'.repeat(5000), outputText: 'hi' },
      { spanId: 's', traceId: 't' },
    );
    const meta = span.meta as Record<string, unknown>;
    assert.equal((meta.input as { value: string }).value.length, 4000, 'content is bounded, never sent unbounded');
    assert.equal((meta.output as { value: string }).value, 'hi');
  });
});

test('buildLlmObsSpan: an error span sets status=error and a truncated meta.error, never a fake ok', () => {
  const span = buildLlmObsSpan({ name: 'x', kind: 'tool', startNs: 0, durationNs: 1, ok: false, errorMessage: 'z'.repeat(1000) }, { spanId: 's', traceId: 't' });
  assert.equal(span.status, 'error');
  const meta = span.meta as Record<string, unknown>;
  assert.equal((meta.error as { message: string }).message.length, 500, 'error message is bounded');
});

test('buildLlmObsSpan: non-finite/absent token counts are dropped; metrics omitted entirely when none finite', () => {
  const span = buildLlmObsSpan({ name: 'x', kind: 'tool', startNs: 0, durationNs: 0, ok: true, inputTokens: Number.NaN }, { spanId: 's', traceId: 't' });
  assert.equal(span.metrics, undefined);
});

test('buildLlmObsPayload: wraps spans under data.type=span with ml_app + tags attributes', () => {
  const span = buildLlmObsSpan({ name: 'x', kind: 'llm', startNs: 0, durationNs: 0, ok: true }, { spanId: 's', traceId: 't' });
  const payload = buildLlmObsPayload([span], 'otchealth-gateway', ['env:test']);
  assert.ok(payload);
  assert.equal(payload!.data.type, 'span');
  assert.equal(payload!.data.attributes.ml_app, 'otchealth-gateway');
  assert.deepEqual(payload!.data.attributes.tags, ['env:test']);
  assert.equal((payload!.data.attributes.spans as unknown[]).length, 1);
});

test('buildLlmObsPayload: returns null for an empty span list (mirrors buildSeriesPayload)', () => {
  assert.equal(buildLlmObsPayload([]), null);
});

// ---------------------------------------------------------------------------------------------
// Gating (emitLlmObsSpan) -- the INERT-BY-DEFAULT safety contract, proven with a stubbed fetch.
// ---------------------------------------------------------------------------------------------

test('emitLlmObsSpan: inert (no fetch call) when DD_LLMOBS_ENABLED is unset, even with a real-looking key present', () => {
  withEnv({ DD_API_KEY: 'dd-test-key' }, () => {
    let calls = 0;
    withStubbedFetch(
      (async () => {
        calls++;
        return new Response('{}', { status: 202 });
      }) as typeof fetch,
      () => {
        emitLlmObsSpan({ name: 'x', kind: 'llm', startNs: nowNs(), durationNs: 1, ok: true });
      },
    );
    assert.equal(calls, 0, 'must not call fetch at all while DD_LLMOBS_ENABLED is unset');
  });
});

test('emitLlmObsSpan: inert (no fetch call) when DD_LLMOBS_ENABLED=1 but no Datadog key resolves', () => {
  withEnv({ DD_LLMOBS_ENABLED: '1' }, () => {
    let calls = 0;
    withStubbedFetch(
      (async () => {
        calls++;
        return new Response('{}', { status: 202 });
      }) as typeof fetch,
      () => {
        emitLlmObsSpan({ name: 'x', kind: 'llm', startNs: nowNs(), durationNs: 1, ok: true });
      },
    );
    assert.equal(calls, 0, 'flag on but no key resolved -> still no network call');
  });
});

test('emitLlmObsSpan: enabled + key present -> posts to the LLM Observability Spans intake with DD-API-KEY and the right body', () => {
  withEnv({ DD_LLMOBS_ENABLED: '1', DD_API_KEY: 'dd-test-key', DD_SITE: 'us3.datadoghq.com' }, () => {
    let calls = 0;
    let capturedUrl = '';
    let capturedInit: RequestInit | undefined;
    withStubbedFetch(
      (async (url: string | URL | Request, init?: RequestInit) => {
        calls++;
        capturedUrl = String(url);
        capturedInit = init;
        return new Response('{}', { status: 202 });
      }) as typeof fetch,
      () => {
        emitLlmObsSpan({
          name: 'bedrock.apply_guardrail.shield',
          kind: 'tool',
          startNs: nowNs(),
          durationNs: 1_000_000,
          ok: true,
          provider: 'bedrock',
          metadata: { attack_detected: false },
        });
      },
    );
    assert.equal(calls, 1);
    assert.equal(capturedUrl, 'https://api.us3.datadoghq.com/api/intake/llm-obs/v1/trace/spans');
    const headers = capturedInit?.headers as Record<string, string>;
    assert.equal(headers['DD-API-KEY'], 'dd-test-key');
    const body = JSON.parse(String(capturedInit?.body));
    assert.equal(body.data.type, 'span');
    assert.equal(body.data.attributes.ml_app, 'otchealth-gateway');
    assert.equal(body.data.attributes.spans[0].name, 'bedrock.apply_guardrail.shield');
    assert.equal(body.data.attributes.spans[0].meta.metadata.attack_detected, false);
  });
});

test('emitLlmObsSpan: DD_METRICS_API_KEY takes priority over DD_API_KEY, matching datadog-metrics.ts', () => {
  withEnv({ DD_LLMOBS_ENABLED: '1', DD_API_KEY: 'dd-general', DD_METRICS_API_KEY: 'dd-metrics-specific' }, () => {
    let capturedInit: RequestInit | undefined;
    withStubbedFetch(
      (async (_url: string | URL | Request, init?: RequestInit) => {
        capturedInit = init;
        return new Response('{}', { status: 202 });
      }) as typeof fetch,
      () => {
        emitLlmObsSpan({ name: 'x', kind: 'llm', startNs: nowNs(), durationNs: 1, ok: true });
      },
    );
    const headers = capturedInit?.headers as Record<string, string>;
    assert.equal(headers['DD-API-KEY'], 'dd-metrics-specific');
  });
});

test('emitLlmObsSpan: never throws, even if fetch itself throws synchronously', () => {
  withEnv({ DD_LLMOBS_ENABLED: '1', DD_API_KEY: 'dd-test-key' }, () => {
    withStubbedFetch(
      (() => {
        throw new Error('boom');
      }) as unknown as typeof fetch,
      () => {
        assert.doesNotThrow(() => emitLlmObsSpan({ name: 'x', kind: 'llm', startNs: nowNs(), durationNs: 1, ok: true }));
      },
    );
  });
});
