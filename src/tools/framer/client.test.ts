import test from "node:test";
import assert from "node:assert/strict";
import { connectFramerProject, ENLIGHTENED_LILY_PROJECT_ID, ENLIGHTENED_LILY_PROJECT_URL, type FramerSdkClient } from "./client.js";

const projectUrl = ENLIGHTENED_LILY_PROJECT_URL;

function fakeSdk(overrides: Partial<FramerSdkClient> = {}) {
  const calls: string[] = [];
  const sdk: FramerSdkClient = {
    getProjectInfo: async () => { calls.push("info"); return { id: ENLIGHTENED_LILY_PROJECT_ID, name: "Enlightened Lily" }; },
    getChangedPaths: async () => [],
    isAllowedTo: (method) => method === "getProjectInfo",
    disconnect: async () => { calls.push("disconnect"); },
    ...overrides,
  };
  return { sdk, calls };
}

test("connects to the allow-bound project and returns only read capabilities", async () => {
  const { sdk, calls } = fakeSdk();
  let url = "";
  let key = "";
  const adapter = await connectFramerProject({ projectUrl, apiKey: "opaque-test-key", connect: async (u, k) => { url = u; key = k; return sdk; } });
  assert.equal(url, projectUrl);
  assert.equal(key, "opaque-test-key");
  assert.deepEqual(await adapter.getProjectInfo(), { id: ENLIGHTENED_LILY_PROJECT_ID, name: "Enlightened Lily" });
  assert.deepEqual(await adapter.getCapabilities(), {
    project: { id: ENLIGHTENED_LILY_PROJECT_ID, name: "Enlightened Lily" },
    methods: { getProjectInfo: true, getChangedPaths: false },
  });
  await adapter.close();
  assert.deepEqual(calls, ["info", "disconnect"]);
});

test("refuses a project URL outside the approved project before connecting", async () => {
  let connected = false;
  await assert.rejects(connectFramerProject({
    projectUrl: "https://framer.com/projects/other--other-id",
    apiKey: "opaque-test-key",
    connect: async () => { connected = true; return fakeSdk().sdk; },
  }), { code: "invalid_configuration" });
  assert.equal(connected, false);
});

test("accepts only the exact owner URL while parsing its SDK canonical project ID", async () => {
  let connected = false;
  const adapter = await connectFramerProject({
    projectUrl,
    apiKey: "opaque-test-key",
    connect: async (url) => {
      connected = url === projectUrl;
      return fakeSdk().sdk;
    },
  });
  assert.equal(connected, true);
  assert.equal((await adapter.getProjectInfo()).id, "bdTiiIITB77TCuMA3XFs");
  await adapter.close();
});

test("rejects a different project URL even when its slug resembles the approved URL", async () => {
  let connected = false;
  await assert.rejects(connectFramerProject({
    projectUrl: "https://framer.com/projects/Other--bdTiiIITB77TCuMA3XFs-9ssTK",
    apiKey: "opaque-test-key",
    connect: async () => { connected = true; return fakeSdk().sdk; },
  }), { code: "invalid_configuration" });
  assert.equal(connected, false);
});

test("fails closed and disconnects when Framer reports a different connected project", async () => {
  const { sdk, calls } = fakeSdk({ getProjectInfo: async () => { calls.push("info"); return { id: "other-id-9ssTK", name: "Other" }; } });
  await assert.rejects(connectFramerProject({ projectUrl, apiKey: "opaque-test-key", connect: async () => sdk }), { code: "project_mismatch" });
  assert.deepEqual(calls, ["info", "disconnect"]);
});

test("sanitizes SDK connection errors and disconnects once", async () => {
  await assert.rejects(
    connectFramerProject({ projectUrl, apiKey: "opaque-test-key", connect: async () => { throw new Error("secret-token echoed by SDK"); } }),
    (error: Error) => error.message === "Framer project connection failed." && !error.message.includes("secret-token"),
  );
  const { sdk, calls } = fakeSdk();
  const adapter = await connectFramerProject({ projectUrl, apiKey: "opaque-test-key", connect: async () => sdk });
  await adapter.close();
  await adapter.close();
  assert.deepEqual(calls, ["info", "disconnect"]);
  await assert.rejects(adapter.getProjectInfo(), { code: "read_failed" });
});
