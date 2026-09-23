import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const REPOSITORY = 'InnerScopeHearing/otchealth-cto';
const REPOSITORY_ID = 123456789;
const RUN_ID = 35170671551;
const ARTIFACT_ID = 10476469182;
const ARTIFACT_NAME = 'graphrag-fifth-source-provider-observation-35170671551';
const HEAD_SHA = '854766e709aefcf2826cc0b5dc75c028b9b566dc';
const WORKFLOW_PATH = '.github/workflows/observe-managed-graphrag-company-fifth-source.yml@main';
const WORKFLOW_BLOB_SHA = '3e2f2554443fee7cb113f4f6435262cd2ec0c273';
const PRODUCER_BLOB_SHA = '37e4a762a50b0d239c610158ca02bc7a2f29dde8';
const SOURCE_ID = 'LVEV3LT7LB';
const INGESTION_JOB_ID = 'FBHZYSWJ9D';
const KNOWLEDGE_BASE_ID = 'XNMHPUKGDT';
const DOWNLOAD_URL = 'https://pipelines.actions.githubusercontent.com/download/fixture?sig=mock-sensitive-url';

before(() => {
  process.env.CIO_SITE_ID = 'test';
  process.env.CIO_TRACK_KEY = 'test';
  process.env.CIO_APP_API_BEARER = 'test';
  process.env.PERPLEXITY_CONNECTOR_TOKEN = 'a'.repeat(32);
  process.env.ADMIN_REVOKE_TOKEN = 'b'.repeat(32);
  process.env.N8N_WEBHOOK_SECRET = 'c'.repeat(32);

  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
  });
  process.env.GITHUB_APP_ID = '123456';
  process.env.GITHUB_APP_INSTALLATION_ID = '789';
  process.env.GITHUB_APP_PRIVATE_KEY = privateKey;
});

type ZipMember = { name: string; data: Buffer; externalAttributes?: number; method?: 'store' | 'deflate'; dataDescriptor?: boolean };

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zipStore(members: ZipMember[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let localOffset = 0;

  for (const member of members) {
    const name = Buffer.from(member.name, 'utf8');
    const checksum = crc32(member.data);
    const method = member.method === 'deflate' ? 8 : 0;
    const compressed = method === 8 ? deflateRawSync(member.data) : member.data;
    const flags = member.dataDescriptor ? 0x0008 : 0;
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(member.dataDescriptor ? 0 : checksum, 14);
    local.writeUInt32LE(member.dataDescriptor ? 0 : compressed.length, 18);
    local.writeUInt32LE(member.dataDescriptor ? 0 : member.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    name.copy(local, 30);
    localParts.push(local, compressed);
    let descriptorLength = 0;
    if (member.dataDescriptor) {
      const descriptor = Buffer.alloc(16);
      descriptor.writeUInt32LE(0x08074b50, 0);
      descriptor.writeUInt32LE(checksum, 4);
      descriptor.writeUInt32LE(compressed.length, 8);
      descriptor.writeUInt32LE(member.data.length, 12);
      localParts.push(descriptor);
      descriptorLength = descriptor.length;
    }

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(member.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt32LE(0, 36);
    central.writeUInt32LE(member.externalAttributes ?? 0, 38);
    central.writeUInt32LE(localOffset, 42);
    name.copy(central, 46);
    centralParts.push(central);
    localOffset += local.length + compressed.length + descriptorLength;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(members.length, 8);
  end.writeUInt16LE(members.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(localOffset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

function makeReceipt(overrides: Record<string, unknown> = {}): string {
  const receipt = {
    schema: 'managed-graphrag-company-fifth-source-provider-observation-v2',
    read_only: true,
    knowledge_base_id: KNOWLEDGE_BASE_ID,
    source_id: SOURCE_ID,
    ingestion_job_id: INGESTION_JOB_ID,
    provider_status: 'COMPLETE',
    provider_updated_at: '2026-09-16T12:00:00Z',
    terminal: true,
    terminal_statistics: {
      numberOfDocumentsScanned: 112,
      numberOfNewDocumentsIndexed: 109,
      numberOfModifiedDocumentsIndexed: 0,
      numberOfDocumentsDeleted: 0,
      numberOfDocumentsFailed: 3,
    },
    progress_statistics: null,
    ...overrides,
  };
  return JSON.stringify(receipt);
}

function makeRepo(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: REPOSITORY_ID,
    name: 'otchealth-cto',
    full_name: REPOSITORY,
    owner: { login: 'InnerScopeHearing' },
    ...overrides,
  };
}

function makeRun(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: RUN_ID,
    name: 'Observe sealed company GraphRAG fifth-source ingestion',
    path: WORKFLOW_PATH,
    event: 'workflow_dispatch',
    status: 'completed',
    conclusion: 'success',
    head_branch: 'main',
    head_sha: HEAD_SHA,
    repository: { id: REPOSITORY_ID, full_name: REPOSITORY },
    head_repository: { id: REPOSITORY_ID, full_name: REPOSITORY },
    ...overrides,
  };
}

function makeArtifact(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: ARTIFACT_ID,
    name: ARTIFACT_NAME,
    size_in_bytes: 2048,
    expired: false,
    created_at: '2026-09-16T12:00:00Z',
    expires_at: '2099-01-01T00:00:00Z',
    digest: null,
    workflow_run: {
      id: RUN_ID,
      repository_id: REPOSITORY_ID,
      head_repository_id: REPOSITORY_ID,
      head_branch: 'main',
      head_sha: HEAD_SHA,
    },
    ...overrides,
  };
}

type StubOverrides = {
  repo?: Record<string, unknown>;
  run?: Record<string, unknown>;
  workflowBlobSha?: string;
  producerBlobSha?: string;
  artifact?: Record<string, unknown>;
  archive?: Buffer;
  downloadLocation?: string;
};

type CapturedRequest = { url: string; authorization: string | null; method: string };

function githubStub(captured: CapturedRequest[], overrides: StubOverrides = {}): typeof fetch {
  const archive = overrides.archive ?? zipStore([{ name: 'receipt.json', data: Buffer.from(makeReceipt(), 'utf8') }]);
  return (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const headers = new Headers(init.headers);
    captured.push({ url: url.toString(), authorization: headers.get('authorization'), method: init.method ?? 'GET' });

    if (url.origin === 'https://api.github.com' && url.pathname === '/app/installations/789/access_tokens') {
      return new Response(JSON.stringify({ token: 'ghs_test_token', expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString() }), { status: 201 });
    }
    if (url.origin === 'https://api.github.com' && url.pathname === `/repos/${REPOSITORY}`) {
      return new Response(JSON.stringify(overrides.repo ?? makeRepo()), { status: 200 });
    }
    if (url.origin === 'https://api.github.com' && url.pathname === `/repos/${REPOSITORY}/actions/runs/${RUN_ID}`) {
      return new Response(JSON.stringify(overrides.run ?? makeRun()), { status: 200 });
    }
    if (url.origin === 'https://api.github.com' && url.pathname === `/repos/${REPOSITORY}/contents/.github/workflows/observe-managed-graphrag-company-fifth-source.yml`) {
      return new Response(JSON.stringify({ type: 'file', path: '.github/workflows/observe-managed-graphrag-company-fifth-source.yml', sha: overrides.workflowBlobSha ?? WORKFLOW_BLOB_SHA }), { status: 200 });
    }
    if (url.origin === 'https://api.github.com' && url.pathname === `/repos/${REPOSITORY}/contents/scripts/observe_managed_graphrag_company_fifth_source.py`) {
      return new Response(JSON.stringify({ type: 'file', path: 'scripts/observe_managed_graphrag_company_fifth_source.py', sha: overrides.producerBlobSha ?? PRODUCER_BLOB_SHA }), { status: 200 });
    }
    if (url.origin === 'https://api.github.com' && url.pathname === `/repos/${REPOSITORY}/actions/artifacts/${ARTIFACT_ID}`) {
      return new Response(JSON.stringify(overrides.artifact ?? makeArtifact()), { status: 200 });
    }
    if (url.origin === 'https://api.github.com' && url.pathname === `/repos/${REPOSITORY}/actions/artifacts/${ARTIFACT_ID}/zip`) {
      return new Response(null, { status: 302, headers: { location: overrides.downloadLocation ?? DOWNLOAD_URL } });
    }
    if (url.toString() === (overrides.downloadLocation ?? DOWNLOAD_URL)) {
      return new Response(archive, { status: 200, headers: { 'content-length': String(archive.length) } });
    }
    throw new Error('unexpected mocked GitHub request');
  }) as typeof fetch;
}

async function withStubbedFetch<T>(stub: typeof fetch, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

async function callThroughRealMcpServer(
  args: Record<string, unknown> = {},
  callerAgent = 'cto',
): Promise<{ isError?: boolean; content: Array<{ type: string; text?: string }>; structuredContent?: any }> {
  const { registerGitHubGraphRagObservationReceipt } = await import('./graphrag-observation-receipt.js');
  const { requestContext } = await import('../../server/request-context.js');
  const mcp = new McpServer({ name: 'test', version: '0' }, { capabilities: { tools: { listChanged: true }, logging: {} } });
  registerGitHubGraphRagObservationReceipt(mcp, () => 'test-caller-hash');

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0' }, { capabilities: {} });
  await Promise.all([mcp.connect(serverTransport), client.connect(clientTransport)]);
  try {
    return await requestContext.run(
      { callerHash: 'test-caller-hash', correlationId: 'test-correlation', callerAgent },
      () => client.callTool({ name: 'github_graphrag_observation_receipt_get', arguments: args }) as ReturnType<typeof client.callTool>,
    );
  } finally {
    await client.close();
    await mcp.close();
  }
}

test('pinned observation read verifies provenance, returns only sanitized structure, and drops auth at the signed download boundary', async () => {
  const requests: CapturedRequest[] = [];
  const archive = zipStore([{ name: 'receipt.json', data: Buffer.from(makeReceipt(), 'utf8') }]);
  const digest = createHash('sha256').update(archive).digest('hex');
  const artifact = makeArtifact({ digest: `sha256:${digest}`, size_in_bytes: archive.length });
  const result = await withStubbedFetch(githubStub(requests, { archive, artifact }), () => callThroughRealMcpServer());

  assert.ok(!result.isError, `expected success, got ${JSON.stringify(result)}`);
  const output = result.structuredContent?.result;
  assert.equal(output.schema, 'otchealth-github-managed-graphrag-observation-validation-v1');
  assert.equal(output.run_id, RUN_ID);
  assert.equal(output.artifact_id, ARTIFACT_ID);
  assert.equal(output.knowledge_base_binding_verified, true);
  assert.equal(output.source_id, SOURCE_ID);
  assert.equal(output.ingestion_job_id, INGESTION_JOB_ID);
  assert.equal(output.provider_status, 'COMPLETE');
  assert.equal(output.terminal, true);
  assert.deepEqual(output.terminal_statistics, {
    numberOfDocumentsScanned: 112,
    numberOfNewDocumentsIndexed: 109,
    numberOfModifiedDocumentsIndexed: 0,
    numberOfDocumentsDeleted: 0,
    numberOfDocumentsFailed: 3,
  });
  assert.equal(output.progress_statistics, null);
  assert.equal(output.workflow_provenance_verified, true);
  assert.equal(output.archive_digest_verification, 'verified');
  assert.equal(output.receipt_sha256.length, 64);
  assert.equal(output.archive_sha256.length, 64);
  assert.equal(JSON.stringify(output).includes('mock-sensitive-url'), false);
  assert.equal(Object.hasOwn(output, 'provider_updated_at'), false);
  assert.equal(output.provider_updated_at_present, true);
  assert.equal(JSON.stringify(output).includes('raw'), false);

  const archiveRequest = requests.find((request) => request.url === `https://api.github.com/repos/${REPOSITORY}/actions/artifacts/${ARTIFACT_ID}/zip`);
  const signedDownloadRequest = requests.find((request) => request.url === DOWNLOAD_URL);
  assert.ok(archiveRequest?.authorization?.startsWith('Bearer '), 'the API archive request must use the installation token');
  assert.ok(signedDownloadRequest, 'the GitHub-provided signed URL must be fetched');
  assert.equal(signedDownloadRequest.authorization, null, 'the GitHub installation token must not cross the redirect boundary');
  assert.ok(requests.some((request) => request.url.includes(`/contents/.github/workflows/observe-managed-graphrag-company-fifth-source.yml?ref=${HEAD_SHA}`)));
  assert.ok(requests.some((request) => request.url.includes(`/contents/scripts/observe_managed_graphrag_company_fifth_source.py?ref=${HEAD_SHA}`)));
});

test('pinned observation read explicitly records when GitHub does not provide an archive digest', async () => {
  const requests: CapturedRequest[] = [];
  const result = await withStubbedFetch(githubStub(requests, { artifact: makeArtifact({ digest: null }) }), () => callThroughRealMcpServer());
  assert.ok(!result.isError, `expected success, got ${JSON.stringify(result)}`);
  assert.equal(result.structuredContent?.result.archive_digest_verification, 'not_provided');
});

test('pinned observation read validates a bounded deflated single-member ZIP with a data descriptor', async () => {
  const requests: CapturedRequest[] = [];
  const archive = zipStore([{
    name: 'receipt.json',
    data: Buffer.from(makeReceipt(), 'utf8'),
    method: 'deflate',
    dataDescriptor: true,
  }]);
  const digest = createHash('sha256').update(archive).digest('hex');
  const artifact = makeArtifact({ digest: `sha256:${digest}`, size_in_bytes: archive.length });
  const result = await withStubbedFetch(githubStub(requests, { archive, artifact }), () => callThroughRealMcpServer());
  assert.ok(!result.isError, `expected success, got ${JSON.stringify(result)}`);
  assert.equal(result.structuredContent?.result.archive_digest_verification, 'verified');
  assert.equal(result.structuredContent?.result.terminal, true);
});

test('pinned observation read refuses wrong run provenance before downloading any archive', async () => {
  const requests: CapturedRequest[] = [];
  const result = await withStubbedFetch(
    githubStub(requests, { run: makeRun({ head_sha: '0'.repeat(40) }) }),
    () => callThroughRealMcpServer(),
  );

  assert.equal(result.isError, true);
  assert.equal(requests.some((request) => request.url.endsWith(`/actions/artifacts/${ARTIFACT_ID}/zip`)), false);
  assert.equal(JSON.stringify(result).includes(HEAD_SHA), false);
});

test('pinned observation read refuses a changed producer source or artifact run binding', async (t) => {
  await t.test('producer blob changed', async () => {
    const requests: CapturedRequest[] = [];
    const result = await withStubbedFetch(
      githubStub(requests, { producerBlobSha: '0'.repeat(40) }),
      () => callThroughRealMcpServer(),
    );
    assert.equal(result.isError, true);
    assert.equal(requests.some((request) => request.url.includes(`/actions/artifacts/${ARTIFACT_ID}`)), false);
  });

  await t.test('artifact bound to another head', async () => {
    const requests: CapturedRequest[] = [];
    const artifact = makeArtifact({
      workflow_run: {
        id: RUN_ID,
        repository_id: REPOSITORY_ID,
        head_repository_id: REPOSITORY_ID,
        head_branch: 'main',
        head_sha: '0'.repeat(40),
      },
    });
    const result = await withStubbedFetch(githubStub(requests, { artifact }), () => callThroughRealMcpServer());
    assert.equal(result.isError, true);
    assert.equal(requests.some((request) => request.url.endsWith(`/actions/artifacts/${ARTIFACT_ID}/zip`)), false);
  });
});

test('pinned observation read refuses expired artifacts and mismatching GitHub archive digests', async (t) => {
  await t.test('expired artifact', async () => {
    const requests: CapturedRequest[] = [];
    const expired = makeArtifact({ expired: true, expires_at: '2020-01-01T00:00:00Z' });
    const result = await withStubbedFetch(githubStub(requests, { artifact: expired }), () => callThroughRealMcpServer());
    assert.equal(result.isError, true);
    assert.equal(requests.some((request) => request.url.endsWith(`/actions/artifacts/${ARTIFACT_ID}/zip`)), false);
  });

  await t.test('digest mismatch', async () => {
    const requests: CapturedRequest[] = [];
    const artifact = makeArtifact({ digest: `sha256:${'0'.repeat(64)}` });
    const result = await withStubbedFetch(githubStub(requests, { artifact }), () => callThroughRealMcpServer());
    assert.equal(result.isError, true);
    assert.equal(JSON.stringify(result).includes('0'.repeat(64)), false);
  });

  await t.test('malformed digest', async () => {
    const requests: CapturedRequest[] = [];
    const artifact = makeArtifact({ digest: 'md5:abcd' });
    const result = await withStubbedFetch(githubStub(requests, { artifact }), () => callThroughRealMcpServer());
    assert.equal(result.isError, true);
  });

  await t.test('artifact metadata size above the archive cap', async () => {
    const requests: CapturedRequest[] = [];
    const artifact = makeArtifact({ size_in_bytes: 1024 * 1024 + 1 });
    const result = await withStubbedFetch(githubStub(requests, { artifact }), () => callThroughRealMcpServer());
    assert.equal(result.isError, true);
    assert.equal(requests.some((request) => request.url.endsWith(`/actions/artifacts/${ARTIFACT_ID}/zip`)), false);
  });
});

test('pinned observation read rejects any archive with extra or unsafe members', async (t) => {
  await t.test('extra member', async () => {
    const requests: CapturedRequest[] = [];
    const archive = zipStore([
      { name: 'receipt.json', data: Buffer.from(makeReceipt(), 'utf8') },
      { name: 'private.txt', data: Buffer.from('never return', 'utf8') },
    ]);
    const result = await withStubbedFetch(githubStub(requests, { archive }), () => callThroughRealMcpServer());
    assert.equal(result.isError, true);
    assert.equal(JSON.stringify(result).includes('never return'), false);
  });

  await t.test('unsafe member path', async () => {
    const requests: CapturedRequest[] = [];
    const archive = zipStore([{ name: '../receipt.json', data: Buffer.from(makeReceipt(), 'utf8') }]);
    const result = await withStubbedFetch(githubStub(requests, { archive }), () => callThroughRealMcpServer());
    assert.equal(result.isError, true);
  });

  await t.test('archive byte limit', async () => {
    const requests: CapturedRequest[] = [];
    const archive = Buffer.alloc(1024 * 1024 + 1);
    const result = await withStubbedFetch(githubStub(requests, { archive }), () => callThroughRealMcpServer());
    assert.equal(result.isError, true);
  });

  await t.test('receipt extraction byte limit', async () => {
    const requests: CapturedRequest[] = [];
    const oversized = Buffer.alloc(32 * 1024 + 1, 0x61);
    const archive = zipStore([{ name: 'receipt.json', data: oversized }]);
    const result = await withStubbedFetch(githubStub(requests, { archive }), () => callThroughRealMcpServer());
    assert.equal(result.isError, true);
  });

  await t.test('untrusted download host', async () => {
    const requests: CapturedRequest[] = [];
    const result = await withStubbedFetch(
      githubStub(requests, { downloadLocation: 'https://evil.example/download?sig=do-not-follow' }),
      () => callThroughRealMcpServer(),
    );
    assert.equal(result.isError, true);
    assert.equal(requests.some((request) => request.url.startsWith('https://evil.example/')), false);
    assert.equal(JSON.stringify(result).includes('do-not-follow'), false);
  });
});

test('pinned observation read rejects duplicate JSON keys and nonterminal/incorrectly bound receipts cannot imply terminal success', async (t) => {
  await t.test('duplicate schema key', async () => {
    const requests: CapturedRequest[] = [];
    const raw = makeReceipt().replace('"schema":"managed-graphrag-company-fifth-source-provider-observation-v2"', '"schema":"wrong","schema":"managed-graphrag-company-fifth-source-provider-observation-v2"');
    const archive = zipStore([{ name: 'receipt.json', data: Buffer.from(raw, 'utf8') }]);
    const result = await withStubbedFetch(githubStub(requests, { archive }), () => callThroughRealMcpServer());
    assert.equal(result.isError, true);
  });

  await t.test('source mismatch', async () => {
    const requests: CapturedRequest[] = [];
    const archive = zipStore([{ name: 'receipt.json', data: Buffer.from(makeReceipt({ source_id: 'AAAAAAAAAA' }), 'utf8') }]);
    const result = await withStubbedFetch(githubStub(requests, { archive }), () => callThroughRealMcpServer());
    assert.equal(result.isError, true);
  });

  await t.test('unrecognized top-level field', async () => {
    const requests: CapturedRequest[] = [];
    const archive = zipStore([{ name: 'receipt.json', data: Buffer.from(makeReceipt({ document_text: 'must not pass through' }), 'utf8') }]);
    const result = await withStubbedFetch(githubStub(requests, { archive }), () => callThroughRealMcpServer());
    assert.equal(result.isError, true);
    assert.equal(JSON.stringify(result).includes('must not pass through'), false);
  });

  await t.test('boolean counter is not accepted as an integer', async () => {
    const requests: CapturedRequest[] = [];
    const archive = zipStore([{ name: 'receipt.json', data: Buffer.from(makeReceipt({
      terminal_statistics: {
        numberOfDocumentsScanned: 112,
        numberOfNewDocumentsIndexed: 109,
        numberOfModifiedDocumentsIndexed: 0,
        numberOfDocumentsDeleted: 0,
        numberOfDocumentsFailed: true,
      },
    }), 'utf8') }]);
    const result = await withStubbedFetch(githubStub(requests, { archive }), () => callThroughRealMcpServer());
    assert.equal(result.isError, true);
  });

  await t.test('terminal flag must agree with provider terminal status', async () => {
    const requests: CapturedRequest[] = [];
    const archive = zipStore([{ name: 'receipt.json', data: Buffer.from(makeReceipt({ terminal: false }), 'utf8') }]);
    const result = await withStubbedFetch(githubStub(requests, { archive }), () => callThroughRealMcpServer());
    assert.equal(result.isError, true);
  });

  await t.test('nonterminal observation', async () => {
    const requests: CapturedRequest[] = [];
    const archive = zipStore([{ name: 'receipt.json', data: Buffer.from(makeReceipt({
      provider_status: 'IN_PROGRESS',
      terminal: false,
      terminal_statistics: null,
      progress_statistics: { numberOfDocumentsScanned: 17 },
    }), 'utf8') }]);
    const result = await withStubbedFetch(githubStub(requests, { archive }), () => callThroughRealMcpServer());
    assert.ok(!result.isError, `expected the valid progress observation to be represented, got ${JSON.stringify(result)}`);
    assert.equal(result.structuredContent?.result.terminal, false);
    assert.equal(result.structuredContent?.result.provider_status, 'NONTERMINAL');
    assert.deepEqual(result.structuredContent?.result.progress_statistics, { numberOfDocumentsScanned: 17 });
    assert.notEqual(result.structuredContent?.result.status, 'terminal_observation_validated');
  });
});

test('pinned observation reader is CTO-only', async () => {
  const requests: CapturedRequest[] = [];
  const result = await withStubbedFetch(githubStub(requests), () => callThroughRealMcpServer({}, 'developer'));
  assert.equal(result.isError, true);
  assert.equal(requests.length, 0, 'role refusal must happen before GitHub API access');
});
