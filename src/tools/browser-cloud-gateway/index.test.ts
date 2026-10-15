import assert from "node:assert/strict";
import { createHash } from 'node:crypto';
import test from "node:test";
import { validateDeterministicPlan } from "./index.js";
import { cloudBrowserActionSchema } from "../browser-cloud/actions.js";
test("durable plans reject durations beyond the session service bound before dispatch", () => {
  const plan = {
    profile_id: "cto-public",
    max_seconds: 180,
    actions: [{ type: "navigate", url: "https://example.com/" }],
  };
  assert.equal(validateDeterministicPlan(plan).max_seconds, 180);
  for (const max_seconds of [181, 300]) assert.throws(() => validateDeterministicPlan({ ...plan, max_seconds }));
});

test("gateway validates bounded tab creation URLs while the session enforces its mode", () => {
  assert.equal(
    cloudBrowserActionSchema.safeParse({
      type: "tab_create",
      url: "https://example.com/",
    }).success,
    true,
  );
  assert.equal(
    cloudBrowserActionSchema.safeParse({
      type: "tab_create",
      url: "http://example.com/",
    }).success,
    true,
  );
  for (const action of [
    { type: "tab_select", targetId: `x${"a".repeat(256)}` },
    { type: "tab_close", targetId: "tab", arbitrary: true },
    { type: "dialog", accept: false, promptText: "bad\u0001value" },
  ])
    assert.equal(cloudBrowserActionSchema.safeParse(action).success, false);
});

test("session action returns opaque target receipts to the authenticated caller", async () => {
  const old = [process.env.CLOUD_BROWSER_ENABLED, process.env.CLOUD_BROWSER_DDB_TABLE, process.env.CLOUD_BROWSER_QUEUE_URL, process.env.CLOUD_BROWSER_ARTIFACT_BUCKET, process.env.READ_ONLY_MODE, process.env.ENABLE_WRITE_TOOLS];
  Object.assign(process.env, {
    CLOUD_BROWSER_ENABLED: "true",
    CLOUD_BROWSER_DDB_TABLE: "t",
    CLOUD_BROWSER_QUEUE_URL: "https://sqs.us-east-1.amazonaws.com/1/q",
    CLOUD_BROWSER_ARTIFACT_BUCKET: "b",
    READ_ONLY_MODE: "false",
    ENABLE_WRITE_TOOLS: "true",
  });
  const runtime = {
    browser: {
      execute: async () => ({
        selectedTargetId: "opaque-tab-2",
        createdTargetId: "opaque-tab-2",
        completed: true,
      }),
    } as never,
    jobs: {} as never,
    queue: {} as never,
    artifacts: {} as never,
  } satisfies CloudBrowserGatewayRuntime;
  const { server, handlers } = fakeServer();
  registerCloudBrowserTools(server, () => "hash", runtime);
  try {
    const result = await requestContext.run(
      {
        callerHash: "h",
        correlationId: "c",
        callerAgent: "cto",
        dryRun: false,
      },
      () =>
        handlers.get("browser_cloud_session_action")!({
          session_id: "s",
          action: { type: "tab_create", url: "https://example.test/" },
          timeout_seconds: 2,
          dry_run: false,
        }),
    );
    assert.deepEqual(result.structuredContent?.result, {
      ok: true,
      created_target_id: "opaque-tab-2",
      selected_target_id: "opaque-tab-2",
    });
  } finally {
    [process.env.CLOUD_BROWSER_ENABLED, process.env.CLOUD_BROWSER_DDB_TABLE, process.env.CLOUD_BROWSER_QUEUE_URL, process.env.CLOUD_BROWSER_ARTIFACT_BUCKET, process.env.READ_ONLY_MODE, process.env.ENABLE_WRITE_TOOLS] = old;
  }
});
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { requestContext } from "../../server/request-context.js";
import { redactCloudBrowserInputForLog, registerCloudBrowserTools, shieldCloudBrowserInput, type CloudBrowserGatewayRuntime } from "./index.js";
import { websitePrincipalHash } from '../browser-cloud/website-login-service.js';
import { intercomPrincipalHash } from '../browser-cloud/intercom-login-service.js';

for (const [key, value] of Object.entries({
  CIO_SITE_ID: "test",
  CIO_TRACK_KEY: "test",
  CIO_APP_API_BEARER: "test",
  PERPLEXITY_CONNECTOR_TOKEN: "a".repeat(32),
  ADMIN_REVOKE_TOKEN: "b".repeat(32),
  N8N_WEBHOOK_SECRET: "c".repeat(32),
}))
  process.env[key] ??= value;

function fakeServer(): {
  server: McpServer;
  handlers: Map<string, (args: unknown) => Promise<{ structuredContent?: Record<string, unknown>; content?: Array<Record<string, unknown>> }>>;
} {
  const handlers = new Map<string, (args: unknown) => Promise<{ structuredContent?: Record<string, unknown>; content?: Array<Record<string, unknown>> }>>();
  return {
    server: {
      registerTool: (name: string, _config: unknown, handler: (args: unknown) => Promise<{ structuredContent?: Record<string, unknown>; content?: Array<Record<string, unknown>> }>) => {
        handlers.set(name, handler);
        return { remove: () => handlers.delete(name) };
      },
    } as unknown as McpServer,
    handlers,
  };
}

test('normal browser lifecycle carries the website connection hash for every eligible lane', async () => {
  const keys = ['CLOUD_BROWSER_ENABLED', 'CLOUD_BROWSER_DDB_TABLE', 'CLOUD_BROWSER_QUEUE_URL', 'CLOUD_BROWSER_ARTIFACT_BUCKET', 'READ_ONLY_MODE', 'ENABLE_WRITE_TOOLS'];
  const previous = keys.map(key => process.env[key]);
  Object.assign(process.env, { CLOUD_BROWSER_ENABLED: 'true', CLOUD_BROWSER_DDB_TABLE: 't', CLOUD_BROWSER_QUEUE_URL: 'https://sqs.us-east-1.amazonaws.com/1/q', CLOUD_BROWSER_ARTIFACT_BUCKET: 'b', READ_ONLY_MODE: 'false', ENABLE_WRITE_TOOLS: 'true' });
  const calls: unknown[][] = [];
  const runtime = { browser: { start: async (...args: unknown[]) => { calls.push(args); return { sessionId: 'owned-session', expiresAt: 1900000000000 }; } } as never, jobs: {} as never, queue: {} as never, artifacts: {} as never } satisfies CloudBrowserGatewayRuntime;
  const { server, handlers } = fakeServer();
  registerCloudBrowserTools(server, () => 'a'.repeat(64), runtime);
  try {
    for (const lane of ['cto', 'cfo', 'clo', 'coo', 'cro', 'developer', 'wefunder-campaign-director']) {
      const result = await requestContext.run({ callerHash: 'a'.repeat(64), correlationId: 'test', callerAgent: lane, authKind: 'oauth', authSubject: 'client', authConnectionId: 'authorization-1' }, () => handlers.get('browser_cloud_session_start')!({ profile_id: 'owned-profile', max_seconds: 60, dry_run: false }));
      assert.equal(result.structuredContent?.result && (result.structuredContent.result as Record<string, unknown>).sessionId, 'owned-session');
      assert.equal(calls.at(-1)?.[0], lane);
      assert.equal(calls.at(-1)?.[4], websitePrincipalHash(lane, 'connection:authorization-1'));
    }
    assert.equal(websitePrincipalHash('coo', 'connection:authorization-1'), intercomPrincipalHash('connection:authorization-1'), 'existing COO profiles remain usable');
  } finally {
    for (const [index, key] of keys.entries()) {
      if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index];
    }
  }
});

test('durable browser job endpoints bind the authenticated connection and redact the binding from readback', async () => {
  const keys = ['CLOUD_BROWSER_ENABLED', 'CLOUD_BROWSER_DDB_TABLE', 'CLOUD_BROWSER_QUEUE_URL', 'CLOUD_BROWSER_ARTIFACT_BUCKET', 'READ_ONLY_MODE', 'ENABLE_WRITE_TOOLS'];
  const previous = keys.map(key => process.env[key]);
  Object.assign(process.env, { CLOUD_BROWSER_ENABLED: 'true', CLOUD_BROWSER_DDB_TABLE: 't', CLOUD_BROWSER_QUEUE_URL: 'https://sqs.us-east-1.amazonaws.com/1/q', CLOUD_BROWSER_ARTIFACT_BUCKET: 'b', READ_ONLY_MODE: 'false', ENABLE_WRITE_TOOLS: 'true' });
  const ownerHash = websitePrincipalHash('wefunder-campaign-director', 'connection:authorization-1');
  const calls: unknown[][] = [];
  const job = { id: 'job-1', agent: 'wefunder-campaign-director', ownerSubjectHash: ownerHash, request: { privatePlan: true }, status: 'queued', artifacts: [] };
  const runtime = { browser: {} as never, jobs: {
    submit: async (input: unknown) => { calls.push(['submit', input]); return { job, replayed: false }; },
    get: async (...args: unknown[]) => { calls.push(['get', ...args]); return job; },
    requestCancellation: async (...args: unknown[]) => { calls.push(['cancel', ...args]); return { ...job, status: 'cancelling' }; },
  } as never, queue: {} as never, artifacts: {} as never } satisfies CloudBrowserGatewayRuntime;
  const { server, handlers } = fakeServer();
  registerCloudBrowserTools(server, () => 'a'.repeat(64), runtime);
  const call = (tool: string, input: unknown) => requestContext.run({ callerHash: 'a'.repeat(64), correlationId: 'test', callerAgent: 'wefunder-campaign-director', authKind: 'oauth', authSubject: 'client', authConnectionId: 'authorization-1' }, () => handlers.get(tool)!(input));
  try {
    await call('browser_cloud_job_submit', { idempotency_key: 'owned-job-1', plan: { profile_id: 'saved-profile', max_seconds: 60, actions: [{ type: 'navigate', url: 'https://example.com/' }] }, dry_run: false });
    assert.equal((calls[0]![1] as { ownerSubjectHash: string }).ownerSubjectHash, ownerHash);
    const found = await call('browser_cloud_job_get', { job_id: 'job-1' });
    assert.deepEqual(calls.at(-1), ['get', 'job-1', 'wefunder-campaign-director', ownerHash]);
    assert.equal(JSON.stringify(found).includes(ownerHash), false);
    assert.equal(JSON.stringify(found).includes('privatePlan'), false);
    await call('browser_cloud_artifact_get', { job_id: 'job-1', artifact_id: 'not-found' });
    assert.deepEqual(calls.at(-1), ['get', 'job-1', 'wefunder-campaign-director', ownerHash]);
    await call('browser_cloud_job_cancel', { job_id: 'job-1', dry_run: false });
    assert.deepEqual(calls.at(-1), ['cancel', 'job-1', 'wefunder-campaign-director', ownerHash]);
  } finally {
    for (const [index, key] of keys.entries()) {
      if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index];
    }
  }
});
test('gateway capture action returns only metadata and an opaque ID, not capture bytes', async () => {
  const old = [process.env.CLOUD_BROWSER_ENABLED, process.env.CLOUD_BROWSER_DDB_TABLE, process.env.CLOUD_BROWSER_QUEUE_URL, process.env.CLOUD_BROWSER_ARTIFACT_BUCKET, process.env.READ_ONLY_MODE, process.env.ENABLE_WRITE_TOOLS];
  Object.assign(process.env, { CLOUD_BROWSER_ENABLED: 'true', CLOUD_BROWSER_DDB_TABLE: 'synthetic-table', CLOUD_BROWSER_QUEUE_URL: 'https://sqs.us-east-1.amazonaws.com/1/q', CLOUD_BROWSER_ARTIFACT_BUCKET: 'synthetic-bucket', READ_ONLY_MODE: 'false', ENABLE_WRITE_TOOLS: 'true' });
  const runtime = { browser: { execute: async () => ({ id: 'bca_123e4567-e89b-42d3-a456-426614174000', owner: 'cto', sessionId: 's', contentType: 'image/png', byteLength: 42, sha256: 'a'.repeat(64), createdAt: 1, body: Buffer.from('must-not-leak') }) }, jobs: {} as never, queue: {} as never, artifacts: {} as never } satisfies CloudBrowserGatewayRuntime;
  const { server, handlers } = fakeServer(); registerCloudBrowserTools(server, () => 'hash', runtime);
  try {
    const good = await requestContext.run({ callerHash: 'h', correlationId: 'c', callerAgent: 'cto', dryRun: false }, () => handlers.get('browser_cloud_session_action')!({ session_id: 's', action: { type: 'capture', request: { type: 'screenshot', format: 'png' } }, timeout_seconds: 5, dry_run: false }));
    assert.deepEqual(good.structuredContent?.result, { ok: true, capture_id: 'bca_123e4567-e89b-42d3-a456-426614174000', content_type: 'image/png', byte_length: 42, sha256: 'a'.repeat(64) });
    assert.equal(JSON.stringify(good.structuredContent).includes('must-not-leak'), false);
  } finally { [process.env.CLOUD_BROWSER_ENABLED, process.env.CLOUD_BROWSER_DDB_TABLE, process.env.CLOUD_BROWSER_QUEUE_URL, process.env.CLOUD_BROWSER_ARTIFACT_BUCKET, process.env.READ_ONLY_MODE, process.env.ENABLE_WRITE_TOOLS] = old; }
});

test('artifact get returns owner-bound captures as native MCP images and PDFs', async () => {
  const old = [process.env.CLOUD_BROWSER_ENABLED, process.env.CLOUD_BROWSER_DDB_TABLE, process.env.CLOUD_BROWSER_QUEUE_URL, process.env.CLOUD_BROWSER_ARTIFACT_BUCKET, process.env.READ_ONLY_MODE, process.env.ENABLE_WRITE_TOOLS];
  Object.assign(process.env, { CLOUD_BROWSER_ENABLED: 'true', CLOUD_BROWSER_DDB_TABLE: 't', CLOUD_BROWSER_QUEUE_URL: 'https://sqs.us-east-1.amazonaws.com/1/q', CLOUD_BROWSER_ARTIFACT_BUCKET: 'b', READ_ONLY_MODE: 'false', ENABLE_WRITE_TOOLS: 'true' });
  const imageBody = Buffer.from('verified image bytes');
  const pdfBody = Buffer.from('verified pdf bytes');
  const sha256 = (body: Buffer) => createHash('sha256').update(body).digest('hex');
  const captures = new Map([
    ['bca_123e4567-e89b-42d3-a456-426614174000', { metadata: { id: 'bca_123e4567-e89b-42d3-a456-426614174000', owner: 'cto', sessionId: '123e4567-e89b-42d3-a456-426614174001', contentType: 'image/png' as const, byteLength: imageBody.byteLength, sha256: sha256(imageBody), createdAt: 1 }, body: imageBody }],
    ['bca_123e4567-e89b-42d3-a456-426614174002', { metadata: { id: 'bca_123e4567-e89b-42d3-a456-426614174002', owner: 'cto', sessionId: '123e4567-e89b-42d3-a456-426614174003', contentType: 'application/pdf' as const, byteLength: pdfBody.byteLength, sha256: sha256(pdfBody), createdAt: 1, pageCount: 1 }, body: pdfBody }],
  ]);
  const captureCalls: string[] = [];
  const runtime = {
    browser: {
      getCapture: async (caller: string, id: string) => {
        captureCalls.push(`${caller}:${id}`);
        const value = captures.get(id);
        if (!value || value.metadata.owner !== caller) throw Object.assign(new Error('denied'), { code: 'owner_forbidden' });
        return value;
      },
    } as never,
    jobs: {} as never, queue: {} as never, artifacts: {} as never,
  } satisfies CloudBrowserGatewayRuntime;
  const { server, handlers } = fakeServer();
  registerCloudBrowserTools(server, () => 'hash', runtime);
  try {
    const imageId = 'bca_123e4567-e89b-42d3-a456-426614174000';
    const imageResult = await requestContext.run({ callerHash: 'h', correlationId: 'c', callerAgent: 'cto', dryRun: false }, () => handlers.get('browser_cloud_artifact_get')!({ job_id: '123e4567-e89b-42d3-a456-426614174001', artifact_id: imageId, dry_run: false }));
    assert.equal((imageResult.structuredContent?.result as { artifact?: { id: string } }).artifact?.id, imageId);
    assert.deepEqual(imageResult.content?.at(-1), { type: 'image', mimeType: 'image/png', data: imageBody.toString('base64') });
    assert.equal(JSON.stringify(imageResult.structuredContent).includes(imageBody.toString()), false);

    const pdfId = 'bca_123e4567-e89b-42d3-a456-426614174002';
    const pdfResult = await requestContext.run({ callerHash: 'h', correlationId: 'c', callerAgent: 'cto', dryRun: false }, () => handlers.get('browser_cloud_artifact_get')!({ job_id: '123e4567-e89b-42d3-a456-426614174003', artifact_id: pdfId, dry_run: false }));
    assert.deepEqual(pdfResult.content?.at(-1), { type: 'resource', resource: { uri: `browser-capture://${pdfId}`, mimeType: 'application/pdf', blob: pdfBody.toString('base64') } });

    const denied = await requestContext.run({ callerHash: 'h', correlationId: 'c', callerAgent: 'cfo', dryRun: false }, () => handlers.get('browser_cloud_artifact_get')!({ job_id: '123e4567-e89b-42d3-a456-426614174001', artifact_id: imageId, dry_run: false }));
    assert.equal((denied.structuredContent?.result as { error?: string }).error, 'owner_forbidden');
    assert.equal(denied.content?.some((block) => block.type === 'image' || block.type === 'resource'), false);
    assert.equal(captureCalls.length, 3);
  } finally { [process.env.CLOUD_BROWSER_ENABLED, process.env.CLOUD_BROWSER_DDB_TABLE, process.env.CLOUD_BROWSER_QUEUE_URL, process.env.CLOUD_BROWSER_ARTIFACT_BUCKET, process.env.READ_ONLY_MODE, process.env.ENABLE_WRITE_TOOLS] = old; }
});

test('capture retrieval rejects session mismatch and hash failure before emitting native content', async () => {
  const old = [process.env.CLOUD_BROWSER_ENABLED, process.env.CLOUD_BROWSER_DDB_TABLE, process.env.CLOUD_BROWSER_QUEUE_URL, process.env.CLOUD_BROWSER_ARTIFACT_BUCKET, process.env.READ_ONLY_MODE, process.env.ENABLE_WRITE_TOOLS];
  Object.assign(process.env, { CLOUD_BROWSER_ENABLED: 'true', CLOUD_BROWSER_DDB_TABLE: 't', CLOUD_BROWSER_QUEUE_URL: 'https://sqs.us-east-1.amazonaws.com/1/q', CLOUD_BROWSER_ARTIFACT_BUCKET: 'b', READ_ONLY_MODE: 'false', ENABLE_WRITE_TOOLS: 'true' });
  const body = Buffer.from('bytes');
  let metadata = { id: 'bca_123e4567-e89b-42d3-a456-426614174000', owner: 'cto', sessionId: '123e4567-e89b-42d3-a456-426614174001', contentType: 'image/png' as const, byteLength: body.byteLength, sha256: createHash('sha256').update(body).digest('hex'), createdAt: 1 };
  const runtime = { browser: { getCapture: async () => ({ metadata, body }) } as never, jobs: {} as never, queue: {} as never, artifacts: {} as never } satisfies CloudBrowserGatewayRuntime;
  const { server, handlers } = fakeServer(); registerCloudBrowserTools(server, () => 'hash', runtime);
  try {
    const call = (job_id: string) => requestContext.run({ callerHash: 'h', correlationId: 'c', callerAgent: 'cto', dryRun: false }, () => handlers.get('browser_cloud_artifact_get')!({ job_id, artifact_id: metadata.id, dry_run: false }));
    const mismatch = await call('123e4567-e89b-42d3-a456-426614174099');
    assert.equal((mismatch.structuredContent?.result as { error?: string }).error, 'capture_integrity_failed');
    assert.equal(mismatch.content?.length, 1);
    metadata = { ...metadata, sha256: '0'.repeat(64) };
    const badHash = await call(metadata.sessionId);
    assert.equal((badHash.structuredContent?.result as { error?: string }).error, 'capture_integrity_failed');
    assert.equal(badHash.content?.length, 1);
  } finally { [process.env.CLOUD_BROWSER_ENABLED, process.env.CLOUD_BROWSER_DDB_TABLE, process.env.CLOUD_BROWSER_QUEUE_URL, process.env.CLOUD_BROWSER_ARTIFACT_BUCKET, process.env.READ_ONLY_MODE, process.env.ENABLE_WRITE_TOOLS] = old; }
});

test('COMPLIANCE_MODE=enforce warns and withholds native captures until acknowledged', async () => {
  const old = [process.env.CLOUD_BROWSER_ENABLED, process.env.CLOUD_BROWSER_DDB_TABLE, process.env.CLOUD_BROWSER_QUEUE_URL, process.env.CLOUD_BROWSER_ARTIFACT_BUCKET, process.env.READ_ONLY_MODE, process.env.ENABLE_WRITE_TOOLS, process.env.COMPLIANCE_MODE];
  Object.assign(process.env, { CLOUD_BROWSER_ENABLED: 'true', CLOUD_BROWSER_DDB_TABLE: 't', CLOUD_BROWSER_QUEUE_URL: 'https://sqs.us-east-1.amazonaws.com/1/q', CLOUD_BROWSER_ARTIFACT_BUCKET: 'b', READ_ONLY_MODE: 'false', ENABLE_WRITE_TOOLS: 'true', COMPLIANCE_MODE: 'enforce' });
  const body = Buffer.from('binary content with clean metadata');
  const id = 'bca_123e4567-e89b-42d3-a456-426614174000';
  const sessionId = '123e4567-e89b-42d3-a456-426614174001';
  const metadata = { id, owner: 'cto', sessionId, contentType: 'image/png' as const, byteLength: body.byteLength, sha256: createHash('sha256').update(body).digest('hex'), createdAt: 1 };
  const runtime = { browser: { getCapture: async () => ({ metadata, body }) } as never, jobs: {} as never, queue: {} as never, artifacts: {} as never } satisfies CloudBrowserGatewayRuntime;
  const { server, handlers } = fakeServer(); registerCloudBrowserTools(server, () => 'hash', runtime);
  const call = (acknowledge_warning: boolean) => requestContext.run({ callerHash: 'h', correlationId: 'c', callerAgent: 'cto', dryRun: false }, () => handlers.get('browser_cloud_artifact_get')!({ job_id: sessionId, artifact_id: id, acknowledge_warning, dry_run: false }));
  try {
    const refused = await call(false);
    assert.equal(refused.structuredContent?.result, null);
    assert.equal((refused.structuredContent?.compliance_warning as { triggers: string[] }).triggers.includes('native_attachment_requires_acknowledgement'), true);
    assert.equal(refused.content?.some((block) => block.type === 'image' || block.type === 'resource'), false);
    const acknowledged = await call(true);
    assert.equal((acknowledged.structuredContent?.result as { artifact?: { id: string } }).artifact?.id, id);
    assert.equal(acknowledged.content?.some((block) => block.type === 'image'), true);
    assert.equal((acknowledged.structuredContent?.compliance_warning as { triggers: string[] }).triggers.includes('native_attachment_requires_acknowledgement'), true);
  } finally { [process.env.CLOUD_BROWSER_ENABLED, process.env.CLOUD_BROWSER_DDB_TABLE, process.env.CLOUD_BROWSER_QUEUE_URL, process.env.CLOUD_BROWSER_ARTIFACT_BUCKET, process.env.READ_ONLY_MODE, process.env.ENABLE_WRITE_TOOLS, process.env.COMPLIANCE_MODE] = old; }
});

test("gateway redaction and shield never retain nested typed text, URL, selector, or plan", () => {
  const raw = {
    action: { type: "type", selector: "#password", text: "typed-secret" },
    plan: {
      actions: [{ type: "navigate", url: "https://private.example/path" }],
    },
  };
  const redacted = JSON.stringify(redactCloudBrowserInputForLog(raw));
  const shield = JSON.stringify(shieldCloudBrowserInput(raw));
  for (const sensitive of ["typed-secret", "private.example", "#password"]) {
    assert.equal(redacted.includes(sensitive), false);
    assert.equal(shield.includes(sensitive), false);
  }
});
test("registered session start derives owner from authenticated context", async () => {
  const oldEnabled = process.env.CLOUD_BROWSER_ENABLED;
  const oldTable = process.env.CLOUD_BROWSER_DDB_TABLE;
  const oldQueue = process.env.CLOUD_BROWSER_QUEUE_URL;
  const oldBucket = process.env.CLOUD_BROWSER_ARTIFACT_BUCKET;
  const oldReadOnly = process.env.READ_ONLY_MODE;
  const oldWrite = process.env.ENABLE_WRITE_TOOLS;
  process.env.CLOUD_BROWSER_ENABLED = "true";
  process.env.CLOUD_BROWSER_DDB_TABLE = "synthetic-table";
  process.env.CLOUD_BROWSER_QUEUE_URL = "https://sqs.us-east-1.amazonaws.com/123/synthetic";
  process.env.CLOUD_BROWSER_ARTIFACT_BUCKET = "synthetic-bucket";
  process.env.READ_ONLY_MODE = "false";
  process.env.ENABLE_WRITE_TOOLS = "true";
  const owners: string[] = [];
  const startArguments: unknown[][] = [];
  const runtime = {
    browser: {
      start: async (owner: string, profileId: string, maxSeconds: number, actionBudget?: number) => {
        owners.push(owner);
        startArguments.push([profileId, maxSeconds, actionBudget]);
        return { sessionId: "s", expiresAt: 1 };
      },
      execute: async () => undefined,
      stop: async () => undefined,
      savePersistentProfile: async () => undefined,
      snapshot: async () => ({}),
      publicTrialProfile: async () => ({
        profileId: "cto-public-trial",
        allowedHosts: ["example.test"],
        persistent: false,
      }),
      provisionPublicTrialProfile: async () => ({
        profileId: "cto-public-trial",
        owner: "cto",
        allowedHosts: ["example.test"],
        persistent: false,
      }),
    },
    jobs: {} as never,
    queue: {} as never,
    artifacts: {} as never,
  } satisfies CloudBrowserGatewayRuntime;
  const { server, handlers } = fakeServer();
  registerCloudBrowserTools(server, () => "hash", runtime);
  try {
    await requestContext.run({ callerHash: "hash", correlationId: "c", callerAgent: "cto" }, () =>
      handlers.get("browser_cloud_session_start")!({
        profile_id: "cto-profile",
        max_seconds: 60,
        dry_run: false,
      }),
    );
    assert.deepEqual(owners, ["cto"]);
    // Older cached clients send only profile_id and max_seconds; the newly optional mission budget
    // must remain source/schema-compatible and default in the service layer.
    assert.deepEqual(startArguments, [["cto-profile", 60, undefined]]);
  } finally {
    process.env.CLOUD_BROWSER_ENABLED = oldEnabled;
    process.env.CLOUD_BROWSER_DDB_TABLE = oldTable;
    process.env.CLOUD_BROWSER_QUEUE_URL = oldQueue;
    process.env.CLOUD_BROWSER_ARTIFACT_BUCKET = oldBucket;
    process.env.READ_ONLY_MODE = oldReadOnly;
    process.env.ENABLE_WRITE_TOOLS = oldWrite;
  }
});
test("public-web discovery and legacy CTO provisioning remain separate and caller-scoped", async () => {
  const old = [process.env.CLOUD_BROWSER_ENABLED, process.env.CLOUD_BROWSER_DDB_TABLE, process.env.CLOUD_BROWSER_QUEUE_URL, process.env.CLOUD_BROWSER_ARTIFACT_BUCKET, process.env.READ_ONLY_MODE, process.env.ENABLE_WRITE_TOOLS];
  Object.assign(process.env, {
    CLOUD_BROWSER_ENABLED: "true",
    CLOUD_BROWSER_DDB_TABLE: "t",
    CLOUD_BROWSER_QUEUE_URL: "https://sqs.us-east-1.amazonaws.com/1/q",
    CLOUD_BROWSER_ARTIFACT_BUCKET: "b",
    READ_ONLY_MODE: "false",
    ENABLE_WRITE_TOOLS: "true",
  });
  const calls: string[] = [];
  const enrollments: string[] = [];
  const runtime = {
    browser: {
      start: async () => ({ sessionId: "s", expiresAt: 1 }),
      execute: async () => undefined,
      stop: async () => undefined,
      savePersistentProfile: async () => undefined,
      snapshot: async () => ({}),
      publicTrialProfile: async (caller: string) => {
        calls.push(`legacy:${caller}`);
        return { profileId: `${caller}-public-trial`, allowedHosts: ["example.test"], persistent: false };
      },
      publicWebProfile: async (caller: string) => {
        calls.push(`public:${caller}`);
        return {
          profileId: `${caller}-public-web`,
          allowedHosts: [],
          persistent: false,
          mode: "public_web",
        };
      },
      provisionPublicTrialProfile: async (caller: string, owner: string, hosts: readonly string[]) => {
        enrollments.push(`${caller}:${owner}:${hosts.join(",")}`);
        return { profileId: `${owner}-public-trial`, owner, allowedHosts: hosts, persistent: false };
      },
    },
    jobs: {} as never,
    queue: {} as never,
    artifacts: {} as never,
  } satisfies CloudBrowserGatewayRuntime;
  const { server, handlers } = fakeServer();
  registerCloudBrowserTools(server, () => "hash", runtime);
  try {
    const legacy = await requestContext.run({ callerHash: "h", correlationId: "c", callerAgent: "cfo" }, () => handlers.get("browser_cloud_profile_discover")!({}));
    assert.equal((legacy.structuredContent?.result as { profile_id?: string }).profile_id, "cfo-public-trial");
    const found = await requestContext.run({ callerHash: "h", correlationId: "c", callerAgent: "cfo" }, () => handlers.get("browser_cloud_public_web_profile_discover")!({}));
    assert.equal((found.structuredContent?.result as { profile_id?: string }).profile_id, "cfo-public-web");
    await requestContext.run({ callerHash: "h", correlationId: "c", callerAgent: "cto" }, () => handlers.get("browser_cloud_profile_provision_public_trial")!({ owner_agent: "cfo", allowed_hosts: ["example.test"], dry_run: false }));
    assert.deepEqual(calls, ["legacy:cfo", "public:cfo"]);
    assert.deepEqual(enrollments, ["cto:cfo:example.test"]);
  } finally {
    [process.env.CLOUD_BROWSER_ENABLED, process.env.CLOUD_BROWSER_DDB_TABLE, process.env.CLOUD_BROWSER_QUEUE_URL, process.env.CLOUD_BROWSER_ARTIFACT_BUCKET, process.env.READ_ONLY_MODE, process.env.ENABLE_WRITE_TOOLS] = old;
  }
});
test("artifact get uses caller-owned job metadata and rejects an integrity mismatch", async () => {
  const old = [process.env.CLOUD_BROWSER_ENABLED, process.env.CLOUD_BROWSER_DDB_TABLE, process.env.CLOUD_BROWSER_QUEUE_URL, process.env.CLOUD_BROWSER_S3_BUCKET, process.env.READ_ONLY_MODE, process.env.ENABLE_WRITE_TOOLS];
  Object.assign(process.env, {
    CLOUD_BROWSER_ENABLED: "true",
    CLOUD_BROWSER_DDB_TABLE: "t",
    CLOUD_BROWSER_QUEUE_URL: "https://sqs.us-east-1.amazonaws.com/1/q",
    CLOUD_BROWSER_S3_BUCKET: "b",
    READ_ONLY_MODE: "false",
    ENABLE_WRITE_TOOLS: "true",
  });
  const artifact = {
    id: "a1",
    storageKey: "browser-cloud/cto/j/a1",
    storageVersion: "v1",
    sha256: "0".repeat(64),
  };
  const calls: string[] = [];
  const runtime = {
    browser: {} as never,
    queue: {} as never,
    jobs: {
      get: async (_id: string, caller: string) => {
        calls.push(caller);
        if (caller !== "cto")
          throw Object.assign(new Error("denied"), {
            code: "job_owner_mismatch",
          });
        return { artifacts: [artifact] };
      },
    } as never,
    artifacts: {
      getVersion: async () => ({
        body: Buffer.from("receipt"),
        contentType: "application/json",
      }),
    } as never,
  } satisfies CloudBrowserGatewayRuntime;
  const { server, handlers } = fakeServer();
  registerCloudBrowserTools(server, () => "hash", runtime);
  try {
    const denied = await requestContext.run({ callerHash: "h", correlationId: "c", callerAgent: "cfo" }, () =>
      handlers.get("browser_cloud_artifact_get")!({
        job_id: "j",
        artifact_id: "a1",
      }),
    );
    assert.equal((denied.structuredContent?.result as { error?: string }).error, "job_owner_mismatch");
    const bad = await requestContext.run({ callerHash: "h", correlationId: "c", callerAgent: "cto" }, () =>
      handlers.get("browser_cloud_artifact_get")!({
        job_id: "j",
        artifact_id: "a1",
      }),
    );
    assert.equal((bad.structuredContent?.result as { error?: string }).error, "artifact_integrity_failed");
    assert.deepEqual(calls, ["cfo", "cto"]);
  } finally {
    [process.env.CLOUD_BROWSER_ENABLED, process.env.CLOUD_BROWSER_DDB_TABLE, process.env.CLOUD_BROWSER_QUEUE_URL, process.env.CLOUD_BROWSER_S3_BUCKET, process.env.READ_ONLY_MODE, process.env.ENABLE_WRITE_TOOLS] = old;
  }
});
