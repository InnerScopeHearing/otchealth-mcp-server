import test from 'node:test';
import assert from 'node:assert/strict';

test('retired Document Intelligence fails closed before provider access', async () => {
  const previousFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    throw new Error('provider access must not occur');
  }) as typeof fetch;
  try {
    const { analyzeDocument } = await import('./client.js');
    process.env.DOCINTEL_ENDPOINT = 'https://retired.example.invalid';
    const result = await analyzeDocument('prebuilt-invoice', { base64Source: 'synthetic' });
    assert.deepEqual(result, {
      status: 'retired',
      error: 'Azure Document Intelligence is retired; no provider call was attempted.',
    });
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = previousFetch;
    delete process.env.DOCINTEL_ENDPOINT;
  }
});
