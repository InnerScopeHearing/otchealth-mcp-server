import { test } from 'node:test';
import assert from 'node:assert/strict';

// Match the required configuration stubs used by the other provider tests, then deliberately
// poison the legacy Foundry settings to prove they cannot reactivate the retired provider.
process.env.CIO_SITE_ID ||= 'test';
process.env.CIO_TRACK_KEY ||= 'test';
process.env.CIO_APP_API_BEARER ||= 'test';
process.env.PERPLEXITY_CONNECTOR_TOKEN ||= 'x'.repeat(32);
process.env.ADMIN_REVOKE_TOKEN ||= 'x'.repeat(32);
process.env.N8N_WEBHOOK_SECRET ||= 'x'.repeat(32);
process.env.STATE_BACKEND ||= 'cosmos';
process.env.BLOB_BACKEND ||= 'azure';
process.env.SEARCH_BACKEND ||= 'azure';
process.env.LLM_PROVIDER = 'foundry';
process.env.FOUNDRY_OPENAI_ENDPOINT = 'https://retired-foundry.example.invalid';
process.env.FOUNDRY_KEY = 'test-retired-foundry-key';
process.env.SHIELD_MODE = 'off';
process.env.GROUNDEDNESS_MODE = 'off';

const { registerClaimsCheck } = await import('./claims-check.js');

test('claims_check reports retired Foundry truthfully and never makes an Azure request', async () => {
  type RegisteredHandler = (args: unknown) => Promise<unknown>;
  let registeredName = '';
  let registeredConfig: { description?: string } = {};
  let handler: RegisteredHandler | undefined;
  const server = {
    registerTool: (name: string, config: unknown, registeredHandler: RegisteredHandler) => {
      registeredName = name;
      registeredConfig = config as typeof registeredConfig;
      handler = registeredHandler;
      return { remove: () => undefined };
    },
  } as unknown as import('@modelcontextprotocol/sdk/server/mcp.js').McpServer;

  registerClaimsCheck(server, () => 'synthetic-caller-hash');
  assert.equal(registeredName, 'claims_check');
  assert.match(registeredConfig.description ?? '', /configured OpenAI-direct model/);
  assert.doesNotMatch(registeredConfig.description ?? '', /credit-funded Azure Foundry/);
  assert.ok(handler, 'registerClaimsCheck must register a callable handler');

  let networkCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    networkCalls++;
    throw new Error('retired Foundry must not be contacted');
  }) as typeof fetch;
  let result: unknown;
  try {
    result = await handler({ text: 'A personal sound amplifier for everyday listening.', channel: 'web', productClass: 'PSAP' });
  } finally {
    globalThis.fetch = originalFetch;
  }

  const rendered = JSON.stringify(result);
  assert.match(rendered, /provider_retired/);
  assert.match(rendered, /Foundry is retired and disabled; no Azure request was made\./);
  assert.doesNotMatch(rendered, /Foundry endpoint\/key not configured/);
  assert.equal(networkCalls, 0, 'retired Foundry settings must not produce a provider request');
});

const cleanReview = {
  verdict: 'pass', risk: 4, violations: [],
  compliant_rewrite: 'A personal sound amplifier for everyday listening.', notes: 'No prohibited claims found.',
};

async function invokeClaimsCheck(completion: Record<string, unknown>) {
  type RegisteredHandler = (args: unknown) => Promise<unknown>;
  let handler: RegisteredHandler | undefined;
  const server = {
    registerTool: (_name: string, _config: unknown, registeredHandler: RegisteredHandler) => {
      handler = registeredHandler;
      return { remove: () => undefined };
    },
  } as unknown as import('@modelcontextprotocol/sdk/server/mcp.js').McpServer;
  let requestOptions: unknown;
  registerClaimsCheck(server, () => 'synthetic-caller-hash', {
    isChatConfigured: () => true,
    complete: async (_messages, options) => {
      requestOptions = options;
      return completion as never;
    },
  });
  assert.ok(handler);
  const result = await handler({ text: 'A personal sound amplifier for everyday listening.', channel: 'web', productClass: 'PSAP' }) as {
    content: Array<{ text: string }>;
    structuredContent: { result: Record<string, unknown> };
  };
  return { result: { data: result.structuredContent.result, summary: result.content[0]?.text ?? '' }, requestOptions };
}

test('claims_check accepts clean pass, revise, and high-severity block completions without changing verdict fields', async () => {
  const base = { model: 'gpt-5.6-sol', finishReason: 'stop', usage: { prompt_tokens: 120, completion_tokens: 80 } };
  const pass = await invokeClaimsCheck({ ...base, text: JSON.stringify(cleanReview) });
  assert.equal(pass.result.data.verdict, 'pass');
  assert.equal(pass.result.data.risk, 4);
  assert.deepEqual(pass.result.data.violations, []);
  assert.equal(pass.result.data.compliant_rewrite, cleanReview.compliant_rewrite);
  assert.equal(pass.result.data.model, base.model);
  assert.equal(pass.result.data.finishReason, 'stop');
  assert.equal(pass.result.data.promptTokens, 120);
  assert.equal(pass.result.data.completionTokens, 80);
  assert.deepEqual(pass.requestOptions, { maxTokens: 6000, jsonMode: true, tier: 'high' });

  const reviseReview = {
    verdict: 'revise', risk: 28,
    violations: [{ phrase: 'guaranteed clearer hearing', rule: 'Unsupported outcome promise', severity: 'medium', fix: 'Remove the guarantee.' }],
    compliant_rewrite: 'A sound amplifier for everyday listening.', notes: 'Remove the unsupported guarantee.',
  };
  const revise = await invokeClaimsCheck({ ...base, text: JSON.stringify(reviseReview) });
  assert.equal(revise.result.data.verdict, 'revise');
  assert.deepEqual(revise.result.data.violations, reviseReview.violations);

  const blockReview = {
    verdict: 'block', risk: 92,
    violations: [{ phrase: 'cures hearing loss', rule: 'Medical treatment claim', severity: 'high', fix: 'Remove the treatment claim.' }],
    compliant_rewrite: 'A sound amplifier for everyday listening.', notes: 'Escalate the prohibited claim.',
  };
  const block = await invokeClaimsCheck({ ...base, text: JSON.stringify(blockReview) });
  assert.equal(block.result.data.verdict, 'block');
  assert.deepEqual(block.result.data.violations, blockReview.violations);
});

test('claims_check fails closed on truncation even when the partial body is valid pass JSON', async () => {
  const body = JSON.stringify(cleanReview);
  const { result } = await invokeClaimsCheck({
    text: body, model: 'gpt-5.6-sol', finishReason: 'length',
    usage: { prompt_tokens: 120, completion_tokens: 6000 },
  });
  assert.equal(result.data.verdict, 'error');
  assert.equal(result.data.risk, 100);
  assert.deepEqual(result.data.violations, []);
  assert.equal(result.data.error, 'invalid_model_output:incomplete_completion');
  assert.equal(result.data.finishReason, 'length');
  assert.equal(result.data.completionTokens, 6000);
  assert.doesNotMatch(JSON.stringify(result), /personal sound amplifier|partial body/);
  assert.match(result.summary, /no verdict was issued/);
});

test('claims_check fails closed on malformed, refused, and inconsistent or invalid completions', async () => {
  const base = { model: 'gpt-5.6-sol', finishReason: 'stop' };
  const cases: Array<{ input: Record<string, unknown>; code: string }> = [
    { input: { ...base, text: '{"verdict":"pass"' }, code: 'malformed_json' },
    { input: { ...base, text: JSON.stringify(cleanReview), refusal: 'Synthetic refusal.' }, code: 'model_refusal' },
    { input: { ...base, text: JSON.stringify({ ...cleanReview, risk: 101 }) }, code: 'invalid_risk' },
    { input: { ...base, text: JSON.stringify({ ...cleanReview, verdict: 'unknown' }) }, code: 'invalid_verdict' },
    { input: { ...base, text: JSON.stringify({ ...cleanReview, violations: [{ phrase: 'unsafe', rule: 'r', severity: 'high', fix: 'f' }] }) }, code: 'pass_with_violations' },
    { input: { ...base, text: JSON.stringify({ ...cleanReview, verdict: 'block', risk: 90 }) }, code: 'inconsistent_block_verdict' },
    { input: { ...base, text: JSON.stringify({ ...cleanReview, verdict: 'revise', risk: 20 }) }, code: 'inconsistent_revise_verdict' },
    { input: { ...base, text: JSON.stringify({ ...cleanReview, compliant_rewrite: undefined }) }, code: 'invalid_schema' },
    { input: { ...base, text: JSON.stringify({ ...cleanReview, compliant_rewrite: '' }) }, code: 'invalid_rewrite' },
    { input: { ...base, text: JSON.stringify({ ...cleanReview, unexpected: 'field' }) }, code: 'invalid_schema' },
    { input: { ...base, text: JSON.stringify({ ...cleanReview, violations: [{ phrase: 'claim', rule: 'rule', severity: 'medium', fix: 'fix', unexpected: true }], verdict: 'revise' }) }, code: 'invalid_violations' },
  ];
  for (const { input, code } of cases) {
    const { result } = await invokeClaimsCheck(input);
    assert.equal(result.data.verdict, 'error', code);
    assert.equal(result.data.error, `invalid_model_output:${code}`);
    assert.deepEqual(result.data.violations, []);
    assert.equal(result.data.compliant_rewrite, '');
    assert.doesNotMatch(JSON.stringify(result), /Synthetic refusal|unsafe|personal sound amplifier/);
  }
});
