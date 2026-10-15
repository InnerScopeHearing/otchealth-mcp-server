import test from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "undici";
import { AgentCoreCloudBrowserTransport, isAllowedBrowserUrl } from "./agentcore-transport.js";
import type { CloudBrowserSession } from "./contract.js";
import type { CloudBrowserProfile, CloudBrowserStore } from "./contract.js";
import { CloudBrowserService } from "./service.js";
import { parseTrustedPublicWebPolicy } from './public-web-policy.js';
import { resolveWebsiteLoginTarget } from './website-login-policy.js';

const TEST_PUBLIC_WEB_POLICY = parseTrustedPublicWebPolicy({
  AWS_REGION: 'us-east-1',
  CLOUD_BROWSER_PUBLIC_WEB_CUSTOM_BROWSER_IDENTIFIER: 'browser-isolated-public',
  CLOUD_BROWSER_PUBLIC_WEB_NETWORK_POLICY_VERSION: 'egress-v3',
  CLOUD_BROWSER_PUBLIC_WEB_PRIVATE_HOST_POLICY: 'proxy-acl-v2',
  CLOUD_BROWSER_PUBLIC_WEB_PROXY_SERVER: 'proxy.example.net',
  CLOUD_BROWSER_PUBLIC_WEB_PROXY_PORT: '8080',
});

const session = {
  providerSessionId: "publicsession123",
  automationEndpoint: "wss://bedrock-agentcore.us-east-1.amazonaws.com/test",
} as CloudBrowserSession;
test("public URL mode permits HTTP and HTTPS without relaxing legacy host checks or allowing URL credentials", () => {
  assert.equal(isAllowedBrowserUrl("https://example.com/", ["example.com"]), true);
  assert.equal(isAllowedBrowserUrl("https://other.example/", ["example.com"]), false);
  assert.equal(isAllowedBrowserUrl("http://other.example/", ["example.com"]), false);
  assert.equal(isAllowedBrowserUrl("http://other.example/", [], true), true);
  assert.equal(isAllowedBrowserUrl("https://user:secret@other.example/", [], true), false);
  assert.equal(isAllowedBrowserUrl("javascript:alert(1)", [], true), false);
});
test("provider start omits unsupported tags and stop uses signed PUT query", async (t) => {
  const saved = { ...process.env };
  t.after(() => {
    process.env = saved;
  });
  process.env.AWS_ACCESS_KEY_ID = "test-access";
  process.env.AWS_SECRET_ACCESS_KEY = "test-secret";
  const calls: {
    url: string;
    method: string;
    body: Record<string, unknown>;
  }[] = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      method: init?.method ?? "",
      body: JSON.parse(String(init?.body)),
    });
    return new Response(
      JSON.stringify({
        sessionId: "publicsession123",
        streams: {
          automationStream: { streamEndpoint: session.automationEndpoint },
        },
      }),
    );
  }) as typeof fetch;
  const transport = new AgentCoreCloudBrowserTransport("us-east-1", fetcher);
  await transport.start({
    owner: "cto",
    profile: {
      owner: "cto",
      profileId: "public",
      allowedHosts: ["example.com"],
      persistent: false,
    },
    maxSeconds: 60,
  });
  assert.equal("tags" in calls[0].body, false);
  await transport.stop(session);
  assert.equal(calls[1].method, "PUT");
  assert.equal(new URL(calls[1].url).pathname, "/browsers/aws.browser.v1/sessions/stop");
  assert.equal(new URL(calls[1].url).searchParams.get("sessionId"), "publicsession123");
  assert.equal(typeof calls[1].body.clientToken, "string");
});

test('explicit stop retries reuse a durable StopBrowserSession clientToken without changing the owned provider binding', async t => {
  const saved = { ...process.env };
  t.after(() => { process.env = saved; });
  process.env.AWS_ACCESS_KEY_ID = 'test-access'; process.env.AWS_SECRET_ACCESS_KEY = 'test-secret';
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const transport = new AgentCoreCloudBrowserTransport('us-east-1', async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) }); return new Response('{}');
  });
  const owned = { ...session, providerBrowserId: 'aws.browser.v1', providerStopToken: '2d590f1d-b5ac-4d52-8ccb-15a3e4a57e2c' };
  await transport.stop(owned); await transport.stop(owned);
  assert.equal(calls[0]!.body.clientToken, owned.providerStopToken);
  assert.deepEqual(calls[1], calls[0]);
});

test("public mode starts only on its custom browser with the isolated default proxy and stops that same browser", async (t) => {
  const saved = { ...process.env };
  t.after(() => {
    process.env = saved;
  });
  process.env.AWS_ACCESS_KEY_ID = "test-access";
  process.env.AWS_SECRET_ACCESS_KEY = "test-secret";
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return new Response(
      JSON.stringify({
        sessionId: "publicsession123",
        streams: {
          automationStream: { streamEndpoint: session.automationEndpoint },
        },
      }),
    );
  }) as typeof fetch;
  const transport = new AgentCoreCloudBrowserTransport("us-east-1", fetcher, undefined, undefined, TEST_PUBLIC_WEB_POLICY);
  const profile: CloudBrowserProfile = {
    owner: "cto",
    profileId: "cto-public-web",
    allowedHosts: [],
    persistent: false,
    mode: "public_web",
    customBrowserIdentifier: "browser-isolated-public",
    networkPolicyVersion: "egress-v3",
    privateHostPolicy: "proxy-acl-v2",
    proxyConfiguration: {
      proxies: [{ externalProxy: { server: "proxy.example.net", port: 8080 } }],
    },
    actionBudget: 500,
    maxSessionSeconds: 28_800,
    maxActionSeconds: 120,
  };
  const started = await transport.start({
    owner: "cto",
    profile,
    maxSeconds: 28_800,
  });
  assert.equal(new URL(calls[0].url).pathname, "/browsers/browser-isolated-public/sessions/start");
  assert.deepEqual(calls[0].body.proxyConfiguration, profile.proxyConfiguration);
  assert.equal(started.providerBrowserId, "browser-isolated-public");
  await transport.stop({
    ...session,
    providerBrowserId: started.providerBrowserId,
    mode: "public_web",
  });
  assert.equal(new URL(calls[1].url).pathname, "/browsers/browser-isolated-public/sessions/stop");
});

test("public mode refuses to fall back to the default browser when its network marker is incomplete", async (t) => {
  const saved = { ...process.env };
  t.after(() => {
    process.env = saved;
  });
  process.env.AWS_ACCESS_KEY_ID = "test-access";
  process.env.AWS_SECRET_ACCESS_KEY = "test-secret";
  let called = false;
  const fetcher = (async () => {
    called = true;
    return new Response("{}");
  }) as typeof fetch;
  const transport = new AgentCoreCloudBrowserTransport("us-east-1", fetcher);
  await assert.rejects(
    transport.start({
      owner: "cto",
      profile: {
        owner: "cto",
        profileId: "cto-public-web",
        allowedHosts: [],
        persistent: false,
        mode: "public_web",
      },
      maxSeconds: 60,
    }),
    /trusted runtime configuration/,
  );
  assert.equal(called, false);
});

test("CDP initializes DOM and clicks center through signed injected WebSocket", async (t) => {
  const saved = { ...process.env };
  t.after(() => {
    process.env = saved;
  });
  process.env.AWS_ACCESS_KEY_ID = "test-access";
  process.env.AWS_SECRET_ACCESS_KEY = "test-secret";
  const commands: {
    id: number;
    method: string;
    params: Record<string, unknown>;
  }[] = [];
  let closed = false;
  class Socket extends EventTarget {
    send(raw: string) {
      const cmd = JSON.parse(raw) as (typeof commands)[number];
      commands.push(cmd);
      const replies: Record<string, unknown> = {
        "Target.getTargets": {
          targetInfos: [{ type: "page", targetId: "target" }],
        },
        "Target.attachToTarget": { sessionId: "page" },
        "DOM.performSearch": { resultCount: 1, searchId: "search" },
        "DOM.getSearchResults": { nodeIds: [5] },
        "DOM.getBoxModel": {
          model: { content: [10, 20, 30, 20, 30, 60, 10, 60] },
        },
      };
      queueMicrotask(() =>
        this.dispatchEvent(
          new MessageEvent("message", {
            data: JSON.stringify({
              id: cmd.id,
              result: replies[cmd.method] ?? {},
            }),
          }),
        ),
      );
    }
    close() {
      closed = true;
      this.dispatchEvent(new Event("close"));
    }
  }
  const factory = (_url: string, options: { headers: Record<string, string> }) => {
    assert.ok(Object.keys(options.headers).some((k) => k.toLowerCase() === "authorization"));
    const socket = new Socket();
    queueMicrotask(() => socket.dispatchEvent(new Event("open")));
    return socket as unknown as WebSocket;
  };
  await new AgentCoreCloudBrowserTransport("us-east-1", fetch, factory).execute(session, { type: "click", selector: "#button" }, 2);
  assert.ok(commands.findIndex((c) => c.method === "DOM.getDocument") < commands.findIndex((c) => c.method === "DOM.performSearch"));
  const press = commands.find((c) => c.method === "Input.dispatchMouseEvent");
  assert.deepEqual([press?.params.x, press?.params.y], [20, 40]);
  assert.equal(closed, true);
});

test("selected owned tab is reused after a new provider stream connection", async (t) => {
  const saved = { ...process.env };
  t.after(() => {
    process.env = saved;
  });
  process.env.AWS_ACCESS_KEY_ID = "test-access";
  process.env.AWS_SECRET_ACCESS_KEY = "test-secret";
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  class Socket extends EventTarget {
    send(raw: string) {
      const cmd = JSON.parse(raw) as {
        id: number;
        method: string;
        params: Record<string, unknown>;
      };
      calls.push(cmd);
      const replies: Record<string, unknown> = {
        "Target.getTargets": {
          targetInfos: [
            {
              type: "page",
              targetId: "first",
              url: "https://example.test/one",
            },
            {
              type: "page",
              targetId: "second",
              url: "https://example.test/two",
            },
          ],
        },
        "Target.attachToTarget": { sessionId: String(cmd.params.targetId) },
        "Target.activateTarget": {},
        "Page.getNavigationHistory": {
          currentIndex: 0,
          entries: [{ url: "https://example.test/two", title: "Two" }],
        },
        "Accessibility.getFullAXTree": { nodes: [] },
      };
      queueMicrotask(() =>
        this.dispatchEvent(
          new MessageEvent("message", {
            data: JSON.stringify({
              id: cmd.id,
              result: replies[cmd.method] ?? {},
            }),
          }),
        ),
      );
    }
    close() {
      this.dispatchEvent(new Event("close"));
    }
  }
  const factory = () => {
    const socket = new Socket();
    queueMicrotask(() => socket.dispatchEvent(new Event("open")));
    return socket as unknown as WebSocket;
  };
  const ownedSession = {
    ...session,
    allowedHosts: ["example.test"],
    ownedTargetIds: ["first", "second"],
    selectedTargetId: "first",
  } as CloudBrowserSession;
  const transport = new AgentCoreCloudBrowserTransport("us-east-1", fetch, factory);
  await transport.execute(ownedSession, { type: "tab_select", targetId: "second" }, 2);
  const observation = await transport.execute(ownedSession, { type: "snapshot" }, 2);
  assert.equal(ownedSession.selectedTargetId, "second");
  assert.equal((observation as { url?: string }).url, "https://example.test/two");
  assert.equal(calls.filter((call) => call.method === "Target.attachToTarget").at(-1)?.params.targetId, "second");
});

test('CDP accepts a bounded complete 4 MiB screenshot and denies password controls before capture', async (t) => {
  const saved = { ...process.env };
  t.after(() => { process.env = saved; });
  process.env.AWS_ACCESS_KEY_ID = 'test-access';
  process.env.AWS_SECRET_ACCESS_KEY = 'test-secret';
  const body = Buffer.alloc(4 * 1024 * 1024);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(body);
  Buffer.from([73, 69, 78, 68, 174, 66, 96, 130]).copy(body, body.length - 8);
  const commands: string[] = [];
  let passwordControl = false;
  class Socket extends EventTarget {
    send(raw: string) {
      const cmd = JSON.parse(raw) as { id: number; method: string };
      commands.push(cmd.method);
      const result: Record<string, unknown> = cmd.method === 'Target.getTargets' ? { targetInfos: [{ type: 'page', targetId: 'target' }] } :
        cmd.method === 'Target.attachToTarget' ? { sessionId: 'page' } :
        cmd.method === 'Accessibility.getFullAXTree' ? { nodes: passwordControl ? [{ role: { value: 'password' } }] : [] } :
        cmd.method === 'Page.captureScreenshot' ? { data: body.toString('base64') } : {};
      queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ id: cmd.id, result }) })));
    }
    close() { this.dispatchEvent(new Event('close')); }
  }
  const factory = () => { const socket = new Socket(); queueMicrotask(() => socket.dispatchEvent(new Event('open'))); return socket as unknown as WebSocket; };
  const validator = async ({ body: captured }: { contentType: string; body: Uint8Array }) => ({ complete: captured.byteLength === 4 * 1024 * 1024 });
  const transport = new AgentCoreCloudBrowserTransport('us-east-1', fetch, factory, validator);
  const result = await transport.execute(session, { type: 'capture', request: { type: 'screenshot', format: 'png' } }, 5) as { capture?: { body: Uint8Array; contentType: string } };
  assert.equal(result.capture?.body.byteLength, 4 * 1024 * 1024);
  assert.equal(result.capture?.contentType, 'image/png');
  assert.ok(commands.includes('Page.captureScreenshot'));
  assert.equal(commands.includes('Runtime.evaluate'), false);

  passwordControl = true;
  commands.length = 0;
  await assert.rejects(transport.execute(session, { type: 'capture', request: { type: 'screenshot' } }, 5), (error: unknown) => (error as { code?: unknown }).code === 'sensitive_output_denied');
  assert.equal(commands.includes('Page.captureScreenshot'), false);
});

test('provider upload action resolves owner bytes and attaches them through fixed CDP file-input calls', async (t) => {
  const saved = { ...process.env };
  t.after(() => { process.env = saved; });
  process.env.AWS_ACCESS_KEY_ID = 'test-access';
  process.env.AWS_SECRET_ACCESS_KEY = 'test-secret';
  const body = new TextEncoder().encode('name,value\nexample,1\n');
  const { createHash } = await import('node:crypto');
  const principalHash = 'a'.repeat(64);
  const record = { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', owner: 'cfo', ownerSubjectHash: principalHash, filename: 'report.csv', contentType: 'text/csv', byteLength: body.byteLength, sha256: createHash('sha256').update(body).digest('hex'), status: 'ready' as const, expiresAt: Date.now() + 60_000 };
  const commands: Array<{ method: string; params: Record<string, unknown>; sessionId?: string }> = [];
  let corruptFileReadback = false;
  let rejectFileInputType = false;
  class Socket extends EventTarget {
    send(raw: string) {
      const cmd = JSON.parse(raw) as { id: number; method: string; params: Record<string, unknown>; sessionId?: string };
      commands.push(cmd);
      let result: Record<string, unknown> = {};
      if (cmd.method === 'Target.getTargets') result = { targetInfos: [{ type: 'page', targetId: 'owned-target' }] };
      if (cmd.method === 'Target.attachToTarget') result = { sessionId: 'page-session' };
      if (cmd.method === 'DOM.enable' || cmd.method === 'DOM.getDocument') result = {};
      if (cmd.method === 'DOM.performSearch') result = { searchId: 'search', resultCount: 1 };
      if (cmd.method === 'DOM.getSearchResults') result = { nodeIds: [7] };
      if (cmd.method === 'DOM.describeNode') result = { node: { nodeName: 'INPUT', attributes: ['type', 'file', 'accept', rejectFileInputType ? '.pdf' : '.csv'] } };
      if (cmd.method === 'DOM.resolveNode') result = { object: { objectId: 'input-object' } };
      if (cmd.method === 'Runtime.callFunctionOn') {
        const declaration = String(cmd.params.functionDeclaration);
        if (declaration.includes('this instanceof HTMLInputElement') && declaration.includes('this.isConnected')) result = { result: { value: true } };
        else if (declaration.includes('return []')) result = { result: { objectId: 'parts-object' } };
        else if (declaration.includes('this.push(bytes)')) result = { result: { value: 1 } };
        else if (declaration.includes('this.files = transfer.files')) result = { result: { value: true } };
        else if (declaration.includes('this.files && this.files[0]')) result = { result: { objectId: 'file-object' } };
        else if (declaration.includes('return { name:this.name, size:this.size, type:this.type }')) result = { result: { value: { name: record.filename, size: record.byteLength, type: record.contentType } } };
        else if (declaration.includes('function(offset,length)')) {
          const returned = Buffer.from(body);
          if (corruptFileReadback) returned[0] = returned[0]! ^ 0xff;
          result = { result: { value: { offset: Number((cmd.params.arguments as Array<{ value: number }>)[0]!.value), base64: returned.toString('base64') } } };
        }
      }
      queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ id: cmd.id, result }) })));
    }
    close() { this.dispatchEvent(new Event('close')); }
  }
  const factory = () => { const socket = new Socket(); queueMicrotask(() => socket.dispatchEvent(new Event('open'))); return socket as unknown as WebSocket; };
  const resolvedOwners: string[] = [];
  let resolverUnavailable = false;
  const resolver = async (owner: string, fileId: string, requestedPrincipal?: string) => {
    resolvedOwners.push(owner);
    assert.equal(fileId, record.id);
    assert.equal(requestedPrincipal, principalHash, 'an OAuth caller on a legacy unbound session retains file ownership');
    if (resolverUnavailable) throw new Error('private storage detail must not escape');
    return { record, body };
  };
  const transport = new AgentCoreCloudBrowserTransport('us-east-1', fetch, factory, undefined, undefined, resolver);
  const owned = { ...session, owner: 'cfo', sessionId: 'local', expiresAt: Date.now() + 60_000, ownedTargetIds: ['owned-target'], selectedTargetId: 'owned-target' } as CloudBrowserSession;
  owned.effectUnknown = true; // Simulate the durable pre-dispatch intent persisted by CloudBrowserService.
  resolverUnavailable = true;
  await assert.rejects(transport.execute(owned, { type: 'upload', selector: 'input[type=file]', fileId: record.id }, 10, principalHash), (error: unknown) => (error as { code?: unknown }).code === 'file_unavailable');
  assert.equal(owned.effectUnknown, false, 'known pre-assignment resolver failure clears the upload intent');
  resolverUnavailable = false;
  const result = await transport.execute(owned, { type: 'upload', selector: 'input[type=file]', fileId: record.id }, 10, principalHash) as { fileReceipt?: { status: string; sha256: string } };
  assert.deepEqual(result.fileReceipt, { status: 'attached', filename: record.filename, contentType: record.contentType, byteLength: record.byteLength, sha256: record.sha256 });
  assert.deepEqual(resolvedOwners, ['cfo', 'cfo']);
  assert.ok(commands.some((command) => command.method === 'Runtime.callFunctionOn' && String(command.params.functionDeclaration).includes('this.files = transfer.files')));
  assert.equal(commands.some((command) => command.method === 'Runtime.evaluate'), false);
  assert.ok(commands.filter((command) => command.method === 'Runtime.callFunctionOn').every((command) => command.sessionId === 'page-session'));
  owned.effectUnknown = true;
  rejectFileInputType = true;
  await assert.rejects(transport.execute(owned, { type: 'upload', selector: 'input[type=file]', fileId: record.id }, 10, principalHash), (error: unknown) => (error as { code?: unknown }).code === 'file_input_type_rejected');
  assert.equal(owned.effectUnknown, false, 'known pre-assignment rejection clears the upload intent');
  rejectFileInputType = false;
  owned.effectUnknown = true;
  corruptFileReadback = true;
  await assert.rejects(transport.execute(owned, { type: 'upload', selector: 'input[type=file]', fileId: record.id }, 10, principalHash), (error: unknown) => (error as { code?: unknown }).code === 'file_transfer_uncertain');
  assert.equal(owned.effectUnknown, true, 'a post-dispatch readback failure preserves the uncertainty fence');
});

test("creating a tab with no selection activates it for the required post-action observation", async (t) => {
  const saved = { ...process.env };
  t.after(() => {
    process.env = saved;
  });
  process.env.AWS_ACCESS_KEY_ID = "test-access";
  process.env.AWS_SECRET_ACCESS_KEY = "test-secret";
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  let created = false;
  class Socket extends EventTarget {
    send(raw: string) {
      const cmd = JSON.parse(raw) as {
        id: number;
        method: string;
        params: Record<string, unknown>;
      };
      calls.push(cmd);
      let result: Record<string, unknown> = {};
      if (cmd.method === "Target.getTargets")
        result = {
          targetInfos: [
            ...(created
              ? [
                  {
                    type: "page",
                    targetId: "created-tab",
                    url: "https://example.test/new",
                  },
                ]
              : [
                  {
                    type: "page",
                    targetId: "unowned-popup",
                    url: "https://example.test/popup",
                  },
                ]),
          ],
        };
      if (cmd.method === "Target.createTarget") {
        created = true;
        result = { targetId: "created-tab" };
      }
      if (cmd.method === "Target.activateTarget") result = {};
      if (cmd.method === "Target.attachToTarget") result = { sessionId: "created-page" };
      if (cmd.method === "Page.getNavigationHistory")
        result = {
          currentIndex: 0,
          entries: [{ url: "https://example.test/new", title: "New" }],
        };
      if (cmd.method === "Accessibility.getFullAXTree") result = { nodes: [] };
      queueMicrotask(() =>
        this.dispatchEvent(
          new MessageEvent("message", {
            data: JSON.stringify({ id: cmd.id, result }),
          }),
        ),
      );
    }
    close() {
      this.dispatchEvent(new Event("close"));
    }
  }
  const factory = () => {
    const socket = new Socket();
    queueMicrotask(() => socket.dispatchEvent(new Event("open")));
    return socket as unknown as WebSocket;
  };
  const noSelection = {
    ...session,
    allowedHosts: ["example.test"],
    ownedTargetIds: [],
    selectedTargetId: null,
  } as CloudBrowserSession;
  const transport = new AgentCoreCloudBrowserTransport("us-east-1", fetch, factory);
  const createdResult = (await transport.execute(noSelection, { type: "tab_create", url: "https://example.test/new" }, 2)) as { pageReceipt?: { selectedTargetId?: string | null } };
  assert.equal(createdResult.pageReceipt?.selectedTargetId, "created-tab");
  const observation = (await transport.execute(noSelection, { type: "snapshot" }, 2)) as { url?: string };
  assert.equal(observation.url, "https://example.test/new");
  assert.equal(noSelection.selectedTargetId, "created-tab");
  assert.equal(
    calls.some((call) => call.method === "Target.activateTarget" && call.params.targetId === "created-tab"),
    true,
  );
  assert.equal(
    calls.some((call) => call.method === "Target.attachToTarget" && call.params.targetId === "unowned-popup"),
    false,
  );
});

test("service and AgentCore transport recover through close-last, create, then select", async (t) => {
  const saved = { ...process.env };
  t.after(() => {
    process.env = saved;
  });
  process.env.AWS_ACCESS_KEY_ID = "test-access";
  process.env.AWS_SECRET_ACCESS_KEY = "test-secret";
  const targets = new Map([["first-tab", "https://example.test/first"]]);
  let serial = 0;
  class Socket extends EventTarget {
    send(raw: string) {
      const cmd = JSON.parse(raw) as {
        id: number;
        method: string;
        params: Record<string, unknown>;
      };
      let result: Record<string, unknown> = {};
      if (cmd.method === "Target.getTargets")
        result = {
          targetInfos: [...targets].map(([targetId, url]) => ({
            type: "page",
            targetId,
            url,
          })),
        };
      if (cmd.method === "Target.attachToTarget") result = { sessionId: String(cmd.params.targetId) };
      if (cmd.method === "Target.closeTarget") {
        targets.delete(String(cmd.params.targetId));
        result = { success: true };
      }
      if (cmd.method === "Target.createTarget") {
        const targetId = `created-${++serial}`;
        targets.set(targetId, String(cmd.params.url));
        result = { targetId };
      }
      if (cmd.method === "Page.getNavigationHistory") {
        const url = targets.get("created-1") ?? targets.get("first-tab") ?? "https://example.test/first";
        result = { currentIndex: 0, entries: [{ url, title: "Page" }] };
      }
      if (cmd.method === "Accessibility.getFullAXTree") result = { nodes: [] };
      queueMicrotask(() =>
        this.dispatchEvent(
          new MessageEvent("message", {
            data: JSON.stringify({ id: cmd.id, result }),
          }),
        ),
      );
    }
    close() {
      this.dispatchEvent(new Event("close"));
    }
  }
  const factory = () => {
    const socket = new Socket();
    queueMicrotask(() => socket.dispatchEvent(new Event("open")));
    return socket as unknown as WebSocket;
  };
  class Store implements CloudBrowserStore {
    profiles = new Map<string, CloudBrowserProfile>();
    sessions = new Map<string, CloudBrowserSession>();
    locks = new Set<string>();
    async loadProfile(id: string) {
      return this.profiles.get(id) ?? null;
    }
    async saveProfile(p: CloudBrowserProfile) {
      this.profiles.set(p.profileId, p);
    }
    async loadSession(id: string) {
      return this.sessions.get(id) ?? null;
    }
    async saveSession(s: CloudBrowserSession) {
      this.sessions.set(s.sessionId, s);
    }
    async saveSessionUnderLock(s: CloudBrowserSession) {
      this.sessions.set(s.sessionId, s);
    }
    async deleteSession(id: string) {
      this.sessions.delete(id);
    }
    async acquireSessionLock(id: string) {
      if (this.locks.has(id)) return false;
      this.locks.add(id);
      return true;
    }
    async releaseSessionLock(id: string) {
      this.locks.delete(id);
    }
    async acquireProfileLock(id: string) {
      if (this.locks.has(id)) return false;
      this.locks.add(id);
      return true;
    }
    async releaseProfileLock(id: string) {
      this.locks.delete(id);
    }
    async reserveDailySession() {
      return true;
    }
  }
  const fetcher = (async () =>
    new Response(
      JSON.stringify({
        sessionId: "remote-session",
        streams: {
          automationStream: { streamEndpoint: session.automationEndpoint },
        },
      }),
    )) as typeof fetch;
  const store = new Store();
  const service = new CloudBrowserService(store, new AgentCoreCloudBrowserTransport("us-east-1", fetcher, factory));
  await service.saveProfile("cto", {
    profileId: "cto-owned-tabs",
    owner: "cto",
    allowedHosts: ["example.test"],
    persistent: false,
  });
  const { sessionId } = await service.start("cto", "cto-owned-tabs", 60);
  await service.snapshot("cto", sessionId);
  const close = (await service.execute("cto", sessionId, { type: "tab_close", targetId: "first-tab" }, 2)) as { selectedTargetId?: string | null };
  assert.equal(close.selectedTargetId, null);
  const create = (await service.execute("cto", sessionId, { type: "tab_create", url: "https://example.test/new" }, 2)) as { createdTargetId?: string; selectedTargetId?: string | null };
  assert.equal(create.createdTargetId, "created-1");
  assert.equal(create.selectedTargetId, "created-1");
  const select = (await service.execute("cto", sessionId, { type: "tab_select", targetId: "created-1" }, 2)) as { selectedTargetId?: string };
  assert.equal(select.selectedTargetId, "created-1");
  assert.equal(store.sessions.get(sessionId)?.effectUnknown, false);
});

test('persistent save requires the exact provider profile, browser, session and timestamp receipt', async (t) => {
  const prior = {...process.env};t.after(()=>{process.env=prior;});
  process.env.AWS_ACCESS_KEY_ID='synthetic-save-access';process.env.AWS_SECRET_ACCESS_KEY='synthetic-save-secret';
  const owned={...session,providerBrowserId:'aws.browser.v1'};
  const profile:CloudBrowserProfile={profileId:'coo-owned-profile',owner:'coo',persistent:true,providerProfileId:'cooIntercomAuth_owned-created123',allowedHosts:['app.intercom.com']};
  const valid={profileIdentifier:profile.providerProfileId,browserIdentifier:'aws.browser.v1',sessionId:owned.providerSessionId,lastUpdatedAt:'2026-10-14T00:00:00Z'};
  // @aws-sdk/client-bedrock-agentcore 3.1151.0 SaveBrowserSessionProfileResponse$ uses
  // Smithy schema sentinel 5 (TIMESTAMP_DATE_TIME), overriding REST JSON's epoch default.
  // Its model also explicitly documents ISO 8601. Numeric epoch seconds are not this API's wire format.
  const cases = [
    { payload: valid, accepted: true },
    { payload: { ...valid, lastUpdatedAt: '2026-10-14T00:00:00.123Z' }, accepted: true },
    { payload: { ...valid, lastUpdatedAt: '2026-10-14T07:00:00+07:00' }, accepted: true },
    ...[
      { ...valid, profileIdentifier: 'other-profile' }, { ...valid, browserIdentifier: 'other-browser' },
      { ...valid, sessionId: 'other-session' }, { ...valid, lastUpdatedAt: 'invalid' },
      { ...valid, lastUpdatedAt: 1_791_936_000 }, { ...valid, lastUpdatedAt: null },
      { ...valid, lastUpdatedAt: {} }, {},
    ].map(payload => ({ payload, accepted: false })),
  ];
  for(const {payload, accepted} of cases) {
    let calls=0;
    const transport=new AgentCoreCloudBrowserTransport('us-east-1',async(url,init)=>{
      calls++;
      assert.equal(String(url), `https://bedrock-agentcore.us-east-1.amazonaws.com/browser-profiles/${profile.providerProfileId}/save`);
      assert.equal(init?.method, 'PUT');
      const body = JSON.parse(String(init?.body));
      assert.equal(body.browserIdentifier, owned.providerBrowserId);
      assert.equal(body.sessionId, owned.providerSessionId);
      assert.match(body.clientToken, /^[a-f0-9-]{36}$/);
      return new Response(JSON.stringify(payload),{status:200});
    });
    if(accepted) await transport.saveProfile(owned,profile);
    else await assert.rejects(transport.saveProfile(owned,profile),/exact owned profile/);
    assert.equal(calls,1,'save is never retried');
  }
});

test('fixed website handoff navigates while suppressed and verifies only expected owned page without password', async (t) => {
  const prior = { ...process.env }; t.after(() => { process.env = prior; });
  process.env.AWS_ACCESS_KEY_ID = 'synthetic-login-access'; process.env.AWS_SECRET_ACCESS_KEY = 'synthetic-login-secret';
  const commands: Array<{ method: string; params: Record<string, unknown> }> = [];
  let currentUrl = 'https://wefunder.com/otchealth/editor'; let passwordNode = 0; let targetId = 'owned-target';
  class Socket extends EventTarget {
    send(raw: string) {
      const command = JSON.parse(raw) as { id: number; method: string; params: Record<string, unknown> };
      commands.push(command);
      const result = command.method === 'Target.getTargets' ? { targetInfos: [{ type: 'page', targetId, url: currentUrl }] } :
        command.method === 'Target.attachToTarget' ? { sessionId: 'owned-page' } :
        command.method === 'DOM.getDocument' ? { root: { nodeId: 1 } } :
        command.method === 'DOM.querySelector' ? { nodeId: passwordNode } : {};
      queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ id: command.id, result }) })));
    }
    close() { this.dispatchEvent(new Event('close')); }
  }
  const factory = () => { const socket = new Socket(); queueMicrotask(() => socket.dispatchEvent(new Event('open'))); return socket as unknown as WebSocket; };
  const fetchStream = (async (url, init) => {
    const parsed = new URL(String(url));
    assert.equal(parsed.pathname, '/browsers/aws.browser.v1/sessions/streams/update');
    assert.equal(parsed.searchParams.get('sessionId'), session.providerSessionId);
    assert.equal(init?.method, 'PUT');
    const body = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({
      browserIdentifier: 'aws.browser.v1',
      sessionId: session.providerSessionId,
      streams: { automationStream: { streamStatus: body.streamUpdate.automationStreamUpdate.streamStatus } },
    }));
  }) as typeof fetch;
  const transport = new AgentCoreCloudBrowserTransport('us-east-1', fetchStream, factory);
  const owned = { ...session, owner: 'cto', ownerSubjectHash: 'a'.repeat(64), providerBrowserId: 'aws.browser.v1', allowedHosts: ['wefunder.com'], sensitiveOutputSuppressed: true } as CloudBrowserSession;
  await transport.prepareWebsiteLogin(owned, 'wefunder');
  assert.deepEqual(owned.ownedTargetIds, ['owned-target']); assert.equal(owned.selectedTargetId, 'owned-target');
  assert.equal(commands.find(command => command.method === 'Page.navigate')?.params.url, currentUrl);
  await transport.verifyWebsiteLogin(owned, 'wefunder');
  assert.equal(commands.some(command => command.method.startsWith('Accessibility.') || command.method === 'Runtime.evaluate' || command.method === 'Network.getCookies'), false);
  for (const invalidUrl of ['https://wefunder.com/login', 'https://evil.example/otchealth/editor', 'https://wefunder.com/otchealth/editorial', 'http://wefunder.com/otchealth/editor', 'https://user:pass@wefunder.com/otchealth/editor']) {
    currentUrl = invalidUrl;
    await assert.rejects(transport.verifyWebsiteLogin(owned, 'wefunder'), (error: unknown) => (error as { code?: string }).code === 'company_sign_in_required');
  }
  currentUrl = 'https://wefunder.com/otchealth/editor'; passwordNode = 9;
  await assert.rejects(transport.verifyWebsiteLogin(owned, 'wefunder'), /Complete the company sign-in/);
  passwordNode = 0; targetId = 'foreign-target';
  await assert.rejects(transport.verifyWebsiteLogin(owned, 'wefunder'), /unavailable/);
  const before = commands.length;
  await assert.rejects(transport.prepareWebsiteLogin({ ...owned, sensitiveOutputSuppressed: false }, 'wefunder'), /invalid/);
  await assert.rejects(transport.prepareWebsiteLogin({ ...owned, owner: 'clo-personal' }, 'wefunder'), /invalid/);
  assert.equal(commands.length, before);
  targetId = 'owned-target'; currentUrl = 'https://www.linkedin.com/feed/';
  const linkedin = { ...owned, allowedHosts: ['www.linkedin.com'] };
  await transport.prepareWebsiteLogin(linkedin, 'linkedin');
  await transport.verifyWebsiteLogin(linkedin, 'linkedin');
  currentUrl = 'https://www.linkedin.com/in/company-owner/'; await transport.verifyWebsiteLogin(linkedin, 'linkedin');
  currentUrl = 'https://www.linkedin.com/checkpoint/challenge/'; await assert.rejects(transport.verifyWebsiteLogin(linkedin, 'linkedin'), /requested company website/);
  const target = await resolveWebsiteLoginTarget({ url: 'https://example.com/dashboard/', allowed_hosts: ['accounts.google.com'] }, { lookup: async () => [{ address: '8.8.8.8', family: 4 }] });
  currentUrl = 'https://example.com/dashboard/?account=hidden#state';
  const generic = { ...owned, allowedHosts: [...target.allowedHosts] };
  await transport.prepareWebsiteLogin(generic, 'custom', target);
  assert.equal(commands.filter(command => command.method === 'Page.navigate').at(-1)?.params.url, 'https://example.com/dashboard/');
  await transport.verifyWebsiteLogin(generic, 'custom', target);
  currentUrl = 'https://example.com/dashboard/other'; await assert.rejects(transport.verifyWebsiteLogin(generic, 'custom', target), /requested company website/);
  await assert.rejects(transport.prepareWebsiteLogin(generic, 'custom', { ...target, origin: 'https://other.example.com' }), /public HTTPS website/);
});

