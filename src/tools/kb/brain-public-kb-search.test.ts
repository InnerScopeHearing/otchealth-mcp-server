import test from 'node:test';
import assert from 'node:assert/strict';
import { handleBrainPublicKbSearch } from './brain-public-kb-search.js';

const ctx = (callerAgent: string) => ({ callerAgent, callerHash: 'synthetic', correlationId: 'synthetic', dryRun: false, acknowledgeWarning: false });
const prefix = 's3://otchealth-finance-legal-dr-55c84f6b/graph-trial/20260913/managed-graphrag/company_shared/';
const sourceId = '1ab094b6006bcc487b3e2e78f655ebc0c6628e20ce331a21372cc3c9486b9064';
const secondarySourceId = 'cf198fd8021dfc909fb53778019cf5aaf22b764b4d493ff9993065fdb13b83d6';
const validRow = (overrides: Record<string, unknown> = {}) => ({
  content: { text: 'Public synthetic source text.' },
  location: { type: 'S3', s3Location: { uri: `${prefix}${sourceId}.txt` } },
  metadata: { dataSourceId: 'managed-kb-system-field', secret_metadata: 'must not escape' },
  score: 0.91,
  ...overrides,
});
function harness(response: () => Response = () => Response.json({ retrievalResults: [validRow()] })) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const deps = {
    config: () => ({ kbId: 'ZAYEKIX0RX' }),
    credentials: async () => ({ accessKeyId: 'synthetic', secretAccessKey: 'synthetic' }),
    fetch: (async (url: any, init?: RequestInit) => { calls.push({ url: String(url), init }); return response(); }) as typeof fetch,
  };
  return { deps, calls };
}

test('requires a company seat before config, credentials, or AWS', async () => {
  const h = harness();
  h.deps.credentials = async () => { throw new Error('must not resolve'); };
  const result: any = await handleBrainPublicKbSearch({ query: 'synthetic' }, ctx('clo-personal'), h.deps);
  assert.equal(result.data.error, 'company_seat_required');
  assert.equal(h.calls.length, 0);
});

test('missing or non-allowlisted KB configuration fails closed', async () => {
  const h = harness();
  h.deps.config = () => ({ kbId: undefined });
  const result: any = await handleBrainPublicKbSearch({ query: 'synthetic' }, ctx('cto'), h.deps);
  assert.equal(result.data.error, 'public_knowledge_base_not_configured');
  assert.equal(h.calls.length, 0);
  h.deps.config = () => ({ kbId: 'OTHERKB123' });
  const denied: any = await handleBrainPublicKbSearch({ query: 'synthetic' }, ctx('cto'), h.deps);
  assert.equal(denied.data.error, 'public_knowledge_base_not_configured');
});

test('fixed KB request returns source ids and citations without copying arbitrary metadata', async () => {
  const h = harness();
  const result: any = await handleBrainPublicKbSearch({ query: 'synthetic', top: 2 }, ctx('cfo'), h.deps);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0]?.url, 'https://bedrock-agent-runtime.us-east-1.amazonaws.com/knowledgebases/ZAYEKIX0RX/retrieve');
  assert.equal(h.calls[0]?.init?.redirect, 'error');
  const requestBody = JSON.parse(String(h.calls[0]?.init?.body));
  assert.deepEqual(requestBody.retrievalConfiguration, { managedSearchConfiguration: { numberOfResults: 2 } });
  assert.equal('vectorSearchConfiguration' in requestBody.retrievalConfiguration, false);
  assert.match(String((h.calls[0]?.init?.headers as any).Authorization), /us-east-1\/bedrock\/aws4_request/);
  assert.equal(result.data.mode, 'aws-bedrock-public-company-shared');
  assert.equal(result.data.matches[0].source_id, sourceId);
  assert.equal(result.data.matches[0].citation, `public-kb:${sourceId}`);
  assert.equal(result.data.matches[0].source_uri, `${prefix}${sourceId}.txt`);
  assert.equal(result.data.matches[0].source_url, 'https://otchealthmart.com/pages/about-us');
  assert.equal(result.data.evidence_status, 'candidate_excerpts_only');
  assert.equal(JSON.stringify(result).includes('must not escape'), false);
});

test('any unexpected URI or missing citation withholds the complete response', async () => {
  const rows = [
    validRow(),
    validRow({ location: { type: 'S3', s3Location: { uri: 's3://another-bucket/private.txt' } } }),
  ];
  const h = harness(() => Response.json({ retrievalResults: rows }));
  const result: any = await handleBrainPublicKbSearch({ query: 'synthetic' }, ctx('cto'), h.deps);
  assert.equal(result.data.error, 'invalid_or_uncited_source');
  assert.equal(result.data.count, 0);
  const missingCitation = harness(() => Response.json({ retrievalResults: [validRow({ location: undefined })] }));
  const missing: any = await handleBrainPublicKbSearch({ query: 'synthetic' }, ctx('cto'), missingCitation.deps);
  assert.equal(missing.data.error, 'invalid_or_uncited_source');
  const nonHashName = harness(() => Response.json({ retrievalResults: [validRow({ location: { type: 'S3', s3Location: { uri: `${prefix}ordinary-name.txt` } } })] }));
  const invalidName: any = await handleBrainPublicKbSearch({ query: 'synthetic' }, ctx('cto'), nonHashName.deps);
  assert.equal(invalidName.data.error, 'invalid_or_uncited_source');
  const unknownId = 'f'.repeat(64);
  const unknownHash = harness(() => Response.json({ retrievalResults: [validRow({
    location: { type: 'S3', s3Location: { uri: `${prefix}${unknownId}.txt` } },
  })] }));
  const unknown: any = await handleBrainPublicKbSearch({ query: 'synthetic' }, ctx('cto'), unknownHash.deps);
  assert.equal(unknown.data.error, 'invalid_or_uncited_source');
});

test('out-of-scope control remains explicitly a candidate excerpt, with pinned public source mapping', async () => {
  const h = harness(() => Response.json({ retrievalResults: [validRow({
    location: { type: 'S3', s3Location: { uri: `${prefix}${secondarySourceId}.txt` } },
    content: { text: 'TReO public excerpt.' },
    score: 0.3646,
  })] }));
  const result: any = await handleBrainPublicKbSearch({ query: 'no match' }, ctx('developer'), h.deps);
  assert.equal(result.data.count, 1);
  assert.equal(result.data.matches[0].source_id, secondarySourceId);
  assert.equal(result.data.matches[0].source_url, 'https://otchealthmart.com/collections/treo-by-ihear');
  assert.equal(result.data.matches[0].retrieval_score, 0.3646);
  assert.equal(result.data.evidence_status, 'candidate_excerpts_only');
  assert.match(result.summary, /do not establish relevance/);
  assert.equal(result.data.scope, 'company_shared');
});

test('empty retrieval results are a valid empty response', async () => {
  const h = harness(() => Response.json({ retrievalResults: [] }));
  const result: any = await handleBrainPublicKbSearch({ query: 'no match' }, ctx('developer'), h.deps);
  assert.equal(result.data.count, 0);
  assert.deepEqual(result.data.matches, []);
});
