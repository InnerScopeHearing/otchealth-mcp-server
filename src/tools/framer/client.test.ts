import test from "node:test";
import assert from "node:assert/strict";
import { connectFramerProject, ENLIGHTENED_LILY_PROJECT_ID, type FramerSdkClient } from "./client.js";

const projectUrl = `https://framer.com/projects/Enlightened-Lily--${ENLIGHTENED_LILY_PROJECT_ID}`;

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

test("fails closed and disconnects when Framer reports a different connected project", async () => {
  const { sdk, calls } = fakeSdk({ getProjectInfo: async () => { calls.push("info"); return { id: "other-id", name: "Other" }; } });
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
