import test, { before } from "node:test";
import assert from "node:assert/strict";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { requiredRoleFor, roleAllows } from "../../catalog/governance.js";
import { connectorToolset } from "../registry.js";
import { loadEnv, type Env } from "../../config/env.js";
import { requestContext } from "../../server/request-context.js";
import { connectFramerProject, ENLIGHTENED_LILY_PROJECT_ID, ENLIGHTENED_LILY_PROJECT_URL, FramerAdapterError, type FramerProjectAdapter, type FramerSdkClient } from "./client.js";
import { FRAMER_PROJECT_INSPECT_TOOL, inspectFramerProject, registerFramerProjectInspect } from "./tool.js";

before(() => {
  const required: Record<string, string> = {
    CIO_SITE_ID: "test", CIO_TRACK_KEY: "test", CIO_APP_API_BEARER: "test",
    PERPLEXITY_CONNECTOR_TOKEN: "a".repeat(32), ADMIN_REVOKE_TOKEN: "b".repeat(32), N8N_WEBHOOK_SECRET: "c".repeat(32),
  };
  for (const [key, value] of Object.entries(required)) process.env[key] ??= value;
});

function fakeAdapter(overrides: Partial<FramerProjectAdapter> = {}) {
  let closes = 0;
  const adapter: FramerProjectAdapter = {
    getProjectInfo: async () => ({ id: ENLIGHTENED_LILY_PROJECT_ID, name: "Enlightened Lily" }),
    getCapabilities: async () => ({ project: { id: ENLIGHTENED_LILY_PROJECT_ID, name: "Enlightened Lily" }, readMethods: ["getProjectInfo"], writeMethods: [] }),
    close: async () => { closes += 1; },
    ...overrides,
  };
  return { adapter, get closes() { return closes; } };
}

function fakeServer() {
  const handlers: Record<string, (args: unknown) => Promise<any>> = {};
  const server = {
    registerTool: (name: string, _config: unknown, handler: (args: unknown) => Promise<any>) => { handlers[name] = handler; },
  } as unknown as McpServer;
  return { server, handlers };
}

const callerHash = "a".repeat(64);

test("Framer governance maps exactly to CTO and Developer", () => {
  const rule = requiredRoleFor(FRAMER_PROJECT_INSPECT_TOOL);
  assert.deepEqual(rule?.role, ["cto", "developer"]);
  assert.equal(roleAllows(rule!.role, "cto"), true);
  assert.equal(roleAllows(rule!.role, "developer"), true);
  for (const lane of ["cfo", "clo", "exec", "external-read", ""]) assert.equal(roleAllows(rule!.role, lane), false);
});

test("Framer tool visibility is restricted to CTO and Developer, including explicit shared overrides", () => {
  const env = loadEnv();
  const overridden = { ...env, CONNECTOR_TOOLSET: FRAMER_PROJECT_INSPECT_TOOL } as Env;
  for (const lane of ["cto", "developer"]) {
    assert.equal(connectorToolset(env, lane).has(FRAMER_PROJECT_INSPECT_TOOL), true, `${lane} default`);
    assert.equal(connectorToolset(overridden, lane).has(FRAMER_PROJECT_INSPECT_TOOL), true, `${lane} override`);
  }
  for (const lane of ["cfo", "clo", "clo-personal", "coo", "cro", "cpo", "cco", "exec", "external-read", "wefunder-campaign-director"]) {
    assert.equal(connectorToolset(env, lane).has(FRAMER_PROJECT_INSPECT_TOOL), false, `${lane} default`);
    assert.equal(connectorToolset(overridden, lane).has(FRAMER_PROJECT_INSPECT_TOOL), false, `${lane} override`);
  }
});

test("inspection handler checks the lane before connecting, even outside registry governance", async () => {
  let connected = false;
  await assert.rejects(inspectFramerProject("exec", async () => { connected = true; return fakeAdapter().adapter; }), { code: "forbidden_role" });
  assert.equal(connected, false);
});

test("inspection returns project/read-only surface and always disconnects", async () => {
  const fake = fakeAdapter();
  const result = await inspectFramerProject("developer", async () => fake.adapter);
  assert.deepEqual(result.data, {
    project: { id: ENLIGHTENED_LILY_PROJECT_ID, name: "Enlightened Lily" },
    readMethods: ["getProjectInfo"],
    writeMethods: [],
  });
  assert.equal(fake.closes, 1);
});

test("inspection disconnects after read errors and hides unexpected SDK error text", async () => {
  const fake = fakeAdapter({ getCapabilities: async () => { throw new Error("token-or-websocket-detail"); } });
  await assert.rejects(inspectFramerProject("cto", async () => fake.adapter), (error: Error) => {
    assert.equal(error.message, "Framer project inspection failed.");
    assert.equal(error.message.includes("token-or-websocket-detail"), false);
    return true;
  });
  assert.equal(fake.closes, 1);
});

test("registered inspection uses governance for unauthorized calls and allows Developer", async () => {
  const fake = fakeAdapter();
  let connections = 0;
  const { server, handlers } = fakeServer();
  registerFramerProjectInspect(server, () => callerHash, async () => { connections += 1; return fake.adapter; });

  const denied = await requestContext.run({ callerHash, correlationId: "framer-denied", callerAgent: "cfo" }, () => handlers[FRAMER_PROJECT_INSPECT_TOOL]!({}));
  assert.equal(denied.isError, true);
  assert.equal(denied.structuredContent.error.code, "forbidden_role");
  assert.equal(connections, 0);

  const allowed = await requestContext.run({ callerHash, correlationId: "framer-developer", callerAgent: "developer" }, () => handlers[FRAMER_PROJECT_INSPECT_TOOL]!({}));
  assert.deepEqual(allowed.structuredContent.result.project, { id: ENLIGHTENED_LILY_PROJECT_ID, name: "Enlightened Lily" });
  assert.deepEqual(allowed.structuredContent.result.writeMethods, []);
  assert.equal(connections, 1);
  assert.equal(fake.closes, 1);
});

test("registered inspection sanitizes unexpected runtime errors", async () => {
  const { server, handlers } = fakeServer();
  registerFramerProjectInspect(server, () => callerHash, async () => { throw new Error("secret-token websocket-detail"); });
  const result = await requestContext.run({ callerHash, correlationId: "framer-safe-error", callerAgent: "cto" }, () => handlers[FRAMER_PROJECT_INSPECT_TOOL]!({}));
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error.message, "Framer project inspection failed.");
  assert.equal(JSON.stringify(result.structuredContent).includes("secret-token"), false);
});

test("Framer SDK mocks model unprotected read methods as undefined in isAllowedTo", async () => {
  let permissionCalls = 0;
  let infoReads = 0;
  const sdk: FramerSdkClient = {
    getProjectInfo: async () => { infoReads += 1; return { id: ENLIGHTENED_LILY_PROJECT_ID, name: "Enlightened Lily" }; },
    getChangedPaths: async () => [],
    isAllowedTo: () => { permissionCalls += 1; return undefined; },
    disconnect: async () => undefined,
  };
  const adapter = await connectFramerProject({ projectUrl: ENLIGHTENED_LILY_PROJECT_URL, apiKey: "test-only", connect: async () => sdk });
  assert.equal((await adapter.getProjectInfo()).id, ENLIGHTENED_LILY_PROJECT_ID);
  assert.equal(permissionCalls, 0, "permission-map misses must not gate unprotected reads");
  assert.equal(infoReads, 1);
  await adapter.close();
});
