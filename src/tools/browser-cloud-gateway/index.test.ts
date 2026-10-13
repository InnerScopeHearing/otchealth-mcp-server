import assert from "node:assert/strict";
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
  handlers: Map<string, (args: unknown) => Promise<{ structuredContent?: Record<string, unknown> }>>;
} {
  const handlers = new Map<string, (args: unknown) => Promise<{ structuredContent?: Record<string, unknown> }>>();
  return {
    server: {
      registerTool: (name: string, _config: unknown, handler: (args: unknown) => Promise<{ structuredContent?: Record<string, unknown> }>) => {
        handlers.set(name, handler);
        return { remove: () => handlers.delete(name) };
      },
    } as unknown as McpServer,
    handlers,
  };
}
test('gateway accepts only typed capture requests and returns metadata without capture bytes', async () => {
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
  const runtime = {
    browser: {
      start: async (owner: string) => {
        owners.push(owner);
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
