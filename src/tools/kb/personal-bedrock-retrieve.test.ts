import test from 'node:test';
import assert from 'node:assert/strict';
import { handlePersonalBedrockRetrieve } from './personal-bedrock-retrieve.js';

const ctx = (callerAgent: string) => ({ callerAgent, callerHash: 'synthetic', correlationId: 'synthetic', dryRun: false, acknowledgeWarning: false });
const sourcePrefix = 's3://otchealth-finance-legal-dr-55c84f6b/graph-trial/20260913/managed-graphrag/personal/';
const sourceId = 'a'.repeat(64);
const validRow = (overrides: Record<string, unknown> = {}) => ({
  content: { text: 'Protected synthetic excerpt.' },
  location: { type: 'S3', s3Location: { uri: `${sourcePrefix}${sourceId}.txt` } },
  metadata: {
    source_group: 'personal', source_scope: 'personal', source_id: sourceId, source_version: 'sha256:source-version',
    source_sha256: 'b'.repeat(64), text_sha256: 'c'.repeat(64),
    'x-amz-bedrock-kb-data-source-id': 'KJLMR9R8P5', 'x-amz-bedrock-kb-chunk-id': 'chunk-synthetic-1',
  },
  score: 0.73,
  ...overrides,
});
function harness(response: () => Response = () => Response.json({ retrievalResults: [validRow()] })) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const deps = {
    config: () => ({ enabled: true, kbId: 'XNMHPUKGDT' }),
    credentials: async () => ({ accessKeyId: 'synthetic', secretAccessKey: 'synthetic' }),
    fetch: (async (url: any, init?: RequestInit) => { calls.push({ url: String(url), init }); return response(); }) as typeof fetch,
  };
  return { deps, calls };
}

test('requires exact CLO Personal caller before credentials or AWS', async () => {
  const h = harness();
  h.deps.credentials = async () => { throw new Error('must not resolve'); };
  const result: any = await handlePersonalBedrockRetrieve({ query: 'synthetic' }, ctx('cto'), h.deps);
  assert.equal(result.data.error, 'forbidden_ring');
  assert.equal(h.calls.length, 0);
});

test('pins the current KB and always sends both independently required personal filters', async () => {
  const h = harness();
  const result: any = await handlePersonalBedrockRetrieve({ query: 'synthetic query', top: 3 }, ctx('clo-personal'), h.deps);
  assert.equal(h.calls[0]?.url, 'https://bedrock-agent-runtime.us-east-1.amazonaws.com/knowledgebases/XNMHPUKGDT/retrieve');
  const body = JSON.parse(String(h.calls[0]?.init?.body));
  assert.equal(body.retrievalConfiguration.vectorSearchConfiguration.numberOfResults, 3);
  assert.deepEqual(body.retrievalConfiguration.vectorSearchConfiguration.filter, { andAll: [
    { equals: { key: 'source_group', value: 'personal' } },
    { equals: { key: 'x-amz-bedrock-kb-data-source-id', value: 'KJLMR9R8P5' } },
  ] });
  assert.equal(result.data.count, 1);
  assert.equal(result.data.matches[0].citation, 'bedrock-personal:KJLMR9R8P5:' + sourceId + ':chunk-synthetic-1');
  assert.equal(result.data.matches[0].source_uri, `${sourcePrefix}${sourceId}.txt`);
  assert.equal(result.data.matches[0].source_version, 'sha256:source-version');
  assert.equal(result.data.matches[0].chunk_id, 'chunk-synthetic-1');
  assert.equal(result.data.evidence_status, 'candidate_excerpts_only');
  assert.equal(result.data.graph_traversal_proven, false);
});

test('accepts provider-cited personal-prefix keys without assuming source_scope or flat .txt layout', async () => {
  const nativeShape = validRow({
    location: { type: 'S3', s3Location: { uri: `${sourcePrefix}legacy/nested/source.pdf` } },
    metadata: { ...validRow().metadata, source_scope: 'legacy-label' },
  });
  const h = harness(() => Response.json({ retrievalResults: [nativeShape] }));
  const result: any = await handlePersonalBedrockRetrieve({ query: 'synthetic' }, ctx('clo-personal'), h.deps);
  assert.equal(result.data.count, 1);
  assert.equal(result.data.matches[0].source_uri, `${sourcePrefix}legacy/nested/source.pdf`);
});

test('withholds the whole page on any cross-ring or uncited returned row', async () => {
  for (const bad of [
    validRow({ metadata: { ...validRow().metadata, source_group: 'company' } }),
    validRow({ metadata: { ...validRow().metadata, 'x-amz-bedrock-kb-data-source-id': 'OTHERDS000' } }),
    validRow({ location: { type: 'S3', s3Location: { uri: 's3://other-bucket/company.txt' } } }),
    validRow({ location: { type: 'S3', s3Location: { uri: 's3://otchealth-finance-legal-dr-55c84f6b/graph-trial/20260913/managed-graphrag/company/source.txt' } } }),
    validRow({ metadata: { ...validRow().metadata, 'x-amz-bedrock-kb-chunk-id': undefined } }),
    validRow({ metadata: { ...validRow().metadata, source_id: undefined } }),
    validRow({ metadata: { ...validRow().metadata, source_version: undefined } }),
  ]) {
    const h = harness(() => Response.json({ retrievalResults: [validRow(), bad] }));
    const result: any = await handlePersonalBedrockRetrieve({ query: 'synthetic' }, ctx('clo-personal'), h.deps);
    assert.equal(result.data.error, 'invalid_or_uncited_source');
    assert.equal(result.data.count, 0);
  }
});

test('refuses unconfigured KB and handles empty results without inventing citations', async () => {
  const h = harness();
  h.deps.config = () => ({ enabled: true, kbId: 'OTHERKB123' });
  const denied: any = await handlePersonalBedrockRetrieve({ query: 'synthetic' }, ctx('clo-personal'), h.deps);
  assert.equal(denied.data.error, 'personal_knowledge_base_not_configured');
  assert.equal(h.calls.length, 0);
  h.deps.config = () => ({ enabled: true, kbId: 'XNMHPUKGDT' });
  const emptyHarness = harness(() => Response.json({ retrievalResults: [] }));
  const empty: any = await handlePersonalBedrockRetrieve({ query: 'synthetic' }, ctx('clo-personal'), emptyHarness.deps);
  assert.deepEqual(empty.data.matches, []);
  assert.equal(empty.data.count, 0);
});

test('returns unavailable on credential, provider, and response-size failures', async () => {
  const credentialHarness = harness();
  credentialHarness.deps.credentials = async () => { throw new Error('synthetic credential failure'); };
  const credentialError: any = await handlePersonalBedrockRetrieve({ query: 'synthetic' }, ctx('clo-personal'), credentialHarness.deps);
  assert.equal(credentialError.data.error, 'credentials_unavailable');
  assert.equal(credentialHarness.calls.length, 0);

  const providerHarness = harness(() => new Response(null, { status: 503 }));
  const providerError: any = await handlePersonalBedrockRetrieve({ query: 'synthetic' }, ctx('clo-personal'), providerHarness.deps);
  assert.equal(providerError.data.error, 'bedrock_http_503');

  const timeoutHarness = harness();
  timeoutHarness.deps.fetch = (async () => { throw new DOMException('synthetic timeout', 'TimeoutError'); }) as typeof fetch;
  const timeout: any = await handlePersonalBedrockRetrieve({ query: 'synthetic' }, ctx('clo-personal'), timeoutHarness.deps);
  assert.equal(timeout.data.error, 'bedrock_retrieval_failed');

  const largeHarness = harness(() => new Response(JSON.stringify({ retrievalResults: [] }), { headers: { 'content-length': '600000' } }));
  const large: any = await handlePersonalBedrockRetrieve({ query: 'synthetic' }, ctx('clo-personal'), largeHarness.deps);
  assert.equal(large.data.error, 'bedrock_retrieval_failed');
});

test('truncates long passage text without dropping its provider citation', async () => {
  const longText = 'x'.repeat(9000);
  const h = harness(() => Response.json({ retrievalResults: [validRow({ content: { text: longText } })] }));
  const result: any = await handlePersonalBedrockRetrieve({ query: 'synthetic' }, ctx('clo-personal'), h.deps);
  assert.equal(result.data.matches[0].text.length, 8000);
  assert.equal(result.data.matches[0].truncated, true);
  assert.equal(result.data.matches[0].chunk_id, 'chunk-synthetic-1');
});
