import test from "node:test";
import assert from "node:assert/strict";
import { CloudBrowserError, type BrowserCaptureMetadata, type CloudBrowserProfile, type CloudBrowserSession, type CloudBrowserStore, type CloudBrowserTransport } from "./contract.js";
import { CloudBrowserService } from "./service.js";
import { parseTrustedPublicWebPolicy } from './public-web-policy.js';

const TEST_PUBLIC_WEB_POLICY = parseTrustedPublicWebPolicy({
  AWS_REGION: 'us-east-1',
  CLOUD_BROWSER_PUBLIC_WEB_CUSTOM_BROWSER_IDENTIFIER: 'browser-public-1',
  CLOUD_BROWSER_PUBLIC_WEB_NETWORK_POLICY_VERSION: 'egress-v3',
  CLOUD_BROWSER_PUBLIC_WEB_PRIVATE_HOST_POLICY: 'verified-proxy-acl-v2',
  CLOUD_BROWSER_PUBLIC_WEB_PROXY_SERVER: 'proxy.internal',
  CLOUD_BROWSER_PUBLIC_WEB_PROXY_PORT: '8080',
});

class MemoryStore implements CloudBrowserStore {
  readonly profiles = new Map<string, CloudBrowserProfile>();
  readonly sessions = new Map<string, CloudBrowserSession>();
  dailyReservations = 0;
  readonly locks = new Map<string, string>();
  readonly captures = new Map<string, { metadata: BrowserCaptureMetadata; body: Uint8Array }>();
  async loadProfile(id: string): Promise<CloudBrowserProfile | null> {
    return this.profiles.get(id) ?? null;
  }
  async saveProfile(v: CloudBrowserProfile): Promise<void> {
    this.profiles.set(v.profileId, v);
  }
  async loadSession(id: string): Promise<CloudBrowserSession | null> {
    return this.sessions.get(id) ?? null;
  }
  async saveSession(v: CloudBrowserSession): Promise<void> {
    this.sessions.set(v.sessionId, v);
  }
  async saveSessionUnderLock(v: CloudBrowserSession, _owner: string): Promise<void> {
    this.sessions.set(v.sessionId, v);
  }
  async deleteSession(id: string): Promise<void> {
    this.sessions.delete(id);
  }
  async acquireSessionLock(id: string, owner: string, _until: number): Promise<boolean> {
    if (this.locks.has(`s:${id}`)) return false;
    this.locks.set(`s:${id}`, owner);
    return true;
  }
  async releaseSessionLock(id: string, owner: string): Promise<void> {
    if (this.locks.get(`s:${id}`) === owner) this.locks.delete(`s:${id}`);
  }
  async acquireProfileLock(id: string, owner: string, _until: number): Promise<boolean> {
    if (this.locks.has(`p:${id}`)) return false;
    this.locks.set(`p:${id}`, owner);
    return true;
  }
  async releaseProfileLock(id: string, owner: string): Promise<void> {
    if (this.locks.get(`p:${id}`) === owner) this.locks.delete(`p:${id}`);
  }
  async reserveDailySession(_owner: string, _day: string, _limit: number): Promise<boolean> {
    this.dailyReservations += 1;
    return true;
  }
  async createCapture(owner: string, sessionId: string, artifact: import('./captures.js').BrowserCapturedArtifact, createdAt: number): Promise<BrowserCaptureMetadata> {
    const metadata: BrowserCaptureMetadata = { id: 'bca_123e4567-e89b-42d3-a456-426614174000', owner, sessionId, contentType: artifact.contentType, byteLength: artifact.body.byteLength, sha256: artifact.sha256, createdAt, ...(artifact.pageCount === undefined ? {} : { pageCount: artifact.pageCount }) };
    this.captures.set(metadata.id, { metadata, body: artifact.body });
    return metadata;
  }
  async loadCapture(owner: string, id: string) {
    const value = this.captures.get(id);
    return value?.metadata.owner === owner ? value : null;
  }
}
class FakeTransport implements CloudBrowserTransport {
  readonly actions: unknown[] = [];
  readonly startedProfileIds: string[] = [];
  stopped = 0;
  uncertainCreate = false;
  async start(input: { owner: string; profile: CloudBrowserProfile }): Promise<Pick<CloudBrowserSession, "providerSessionId" | "automationEndpoint">> {
    this.startedProfileIds.push(`${input.owner}:${input.profile.profileId}`);
    return {
      providerSessionId: "remote-session",
      automationEndpoint: "wss://example.test/automation",
    };
  }
  async execute(
    s: CloudBrowserSession,
    action: unknown,
  ): Promise<
    | { url: string; title: string; visibleText: string }
    | null
    | {
        observation: null;
        pageReceipt: {
          selectedTargetId: string | null;
          createdTargetId?: string;
          closedTargetId?: string;
          completed: true;
        };
      }
  > {
    this.actions.push(action);
    const a = action as { type?: string; targetId?: string };
    if (a.type === "snapshot") {
      if (!s.ownedTargetIds) {
        s.ownedTargetIds = ["initial-owned"];
        s.selectedTargetId = "initial-owned";
      }
      if (s.selectedTargetId === null) throw new CloudBrowserError("target_not_selected", "no selected target");
      return {
        url: "https://example.test/",
        title: "Example",
        visibleText: "",
      };
    }
    if (a.type === 'capture') return { observation: null, capture: { contentType: 'image/png', body: Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0,73,69,78,68,174,66,96,130]), sha256: 'a'.repeat(64) } };
    if (a.type === "tab_create") {
      if (this.uncertainCreate) {
        s.effectUnknown = true;
        throw new CloudBrowserError("target_create_uncertain", "uncertain");
      }
      s.ownedTargetIds ??= ["initial-owned"];
      if (s.selectedTargetId === null) s.selectedTargetId = "new-owned";
      s.selectedTargetId ??= "initial-owned";
      s.ownedTargetIds.push("new-owned");
      return {
        observation: null,
        pageReceipt: {
          selectedTargetId: s.selectedTargetId,
          createdTargetId: "new-owned",
          completed: true,
        },
      };
    }
    if (a.type === "tab_select") {
      s.ownedTargetIds ??= ["initial-owned"];
      s.selectedTargetId = a.targetId!;
      return {
        observation: null,
        pageReceipt: { selectedTargetId: a.targetId!, completed: true },
      };
    }
    if (a.type === "tab_close") {
      s.ownedTargetIds ??= ["initial-owned"];
      s.ownedTargetIds = s.ownedTargetIds.filter((id) => id !== a.targetId);
      if (s.selectedTargetId === a.targetId) s.selectedTargetId = null;
      return {
        observation: null,
        pageReceipt: {
          selectedTargetId: s.selectedTargetId ?? null,
          closedTargetId: a.targetId!,
          completed: true,
        },
      };
    }
    return null;
  }
  async stop(): Promise<void> {
    this.stopped += 1;
  }
}

test('unknown provider start retains a durable profile fence and does not start twice', async () => {
  const store = new MemoryStore();
  let starts = 0;
  const transport = new FakeTransport();
  transport.start = async () => { starts++; throw new CloudBrowserError('provider_timeout', 'Provider acknowledgement was lost.'); };
  const service = new CloudBrowserService(store, transport, () => 1_000);
  await service.saveProfile('cto', { profileId: 'cto-start-fence', owner: 'cto', allowedHosts: ['example.test'], persistent: false });
  await assert.rejects(service.start('cto', 'cto-start-fence', 60));
  await assert.rejects(service.start('cto', 'cto-start-fence', 60), (e: unknown) => e instanceof CloudBrowserError && e.code === 'profile_busy');
  assert.equal(starts, 1);
});

test('session persistence remains fenced until a failed start is positively stopped', async () => {
  const store = new MemoryStore();
  const transport = new FakeTransport();
  store.saveSession = async () => { throw new Error('store failure'); };
  transport.stop = async () => { throw new Error('stop outcome unknown'); };
  const service = new CloudBrowserService(store, transport, () => 1_000);
  await service.saveProfile('cto', { profileId: 'cto-save-fence', owner: 'cto', allowedHosts: ['example.test'], persistent: false });
  await assert.rejects(service.start('cto', 'cto-save-fence', 60));
  await assert.rejects(service.start('cto', 'cto-save-fence', 60), (e: unknown) => e instanceof CloudBrowserError && e.code === 'profile_busy');
  assert.equal(transport.startedProfileIds.length, 1);
});

test('sensitive mode blocks snapshots and ordinary browser actions before provider dispatch', async () => {
  const store = new MemoryStore();
  const transport = new FakeTransport();
  const service = new CloudBrowserService(store, transport);
  await service.saveProfile('cto', { profileId: 'cto-suppressed', owner: 'cto', allowedHosts: ['example.test'], persistent: false });
  const { sessionId } = await service.start('cto', 'cto-suppressed', 60);
  await service.beginSensitiveOutputSuppression('cto', sessionId);
  await assert.rejects(service.snapshot('cto', sessionId), (e: unknown) => e instanceof CloudBrowserError && e.code === 'sensitive_output_denied');
  await assert.rejects(service.execute('cto', sessionId, { type: 'click', selector: '#ordinary' }, 2), (e: unknown) => e instanceof CloudBrowserError && e.code === 'sensitive_output_denied');
  assert.equal(transport.actions.length, 0);
  await service.endSensitiveOutputSuppression('cto', sessionId);
  assert.equal((await service.snapshot('cto', sessionId)).url, 'https://example.test/');
});

test('expired session read invokes its owned cleanup adapter without scanning', async () => {
  const store = new MemoryStore() as MemoryStore & { claimExpiredSessionCleanup: () => Promise<boolean>; deleteExpiredSessionUnderLock: (id: string) => Promise<boolean> };
  store.claimExpiredSessionCleanup = async () => true;
  store.deleteExpiredSessionUnderLock = async (id) => { store.sessions.delete(id); return true; };
  const transport = new FakeTransport();
  let now = 1_000;
  const service = new CloudBrowserService(store, transport, () => now);
  await service.saveProfile('cto', { profileId: 'cto-expiry-cleanup', owner: 'cto', allowedHosts: ['example.test'], persistent: false });
  const { sessionId } = await service.start('cto', 'cto-expiry-cleanup', 1);
  now = 3_000;
  await assert.rejects(service.snapshot('cto', sessionId), (e: unknown) => e instanceof CloudBrowserError && e.code === 'session_expired');
  assert.equal(transport.stopped, 1);
  assert.equal(store.sessions.has(sessionId), false);
});

test('file attachment consumes its durable intent once and returns only verified receipt metadata', async () => {
  const store = new MemoryStore();
  const transport = new FakeTransport();
  const original = transport.execute.bind(transport);
  transport.execute = async (session, action) => {
    if ((action as { type: string }).type !== 'upload') return original(session, action);
    assert.equal(store.sessions.get(session.sessionId)?.effectUnknown, true);
    assert.equal(store.sessions.get(session.sessionId)?.actionsUsed, 1);
    return { observation: null, fileReceipt: { status: 'attached', filename: 'check.txt', contentType: 'text/plain', byteLength: 3, sha256: 'a'.repeat(64) } } as never;
  };
  const service = new CloudBrowserService(store, transport);
  await service.saveProfile('cto', { profileId: 'cto-upload', owner: 'cto', allowedHosts: ['example.test'], persistent: false });
  const { sessionId } = await service.start('cto', 'cto-upload', 60);
  const result = await service.execute('cto', sessionId, { type: 'upload', selector: '#file', fileId: '123e4567-e89b-42d3-a456-426614174000' }, 5);
  assert.equal((result as { status: string }).status, 'attached');
  assert.equal(store.sessions.get(sessionId)?.effectUnknown, false);
  assert.equal(store.sessions.get(sessionId)?.actionsUsed, 1);
});

test('uncertain file assignment cannot be repeated automatically', async () => {
  const store = new MemoryStore();
  const transport = new FakeTransport();
  const original = transport.execute.bind(transport);
  let attachments = 0;
  transport.execute = async (session, action) => {
    if ((action as { type: string }).type !== 'upload') return original(session, action);
    attachments++;
    session.effectUnknown = true;
    throw new CloudBrowserError('file_transfer_uncertain', 'File assignment could not be confirmed.');
  };
  const service = new CloudBrowserService(store, transport);
  await service.saveProfile('cto', { profileId: 'cto-upload-unknown', owner: 'cto', allowedHosts: ['example.test'], persistent: false });
  const { sessionId } = await service.start('cto', 'cto-upload-unknown', 60);
  const action = { type: 'upload' as const, selector: '#file', fileId: '123e4567-e89b-42d3-a456-426614174000' };
  await assert.rejects(service.execute('cto', sessionId, action, 5));
  await assert.rejects(service.execute('cto', sessionId, action, 5), (e: unknown) => e instanceof CloudBrowserError && e.code === 'effect_unknown');
  assert.equal(attachments, 1);
});

function serverPublicWebProfile(owner: string, overrides: Partial<CloudBrowserProfile> = {}): CloudBrowserProfile {
  return {
    profileId: `${owner}-public-web`,
    owner,
    allowedHosts: [],
    persistent: false,
    mode: "public_web",
    customBrowserIdentifier: "browser-public-1",
    networkPolicyVersion: "egress-v3",
    privateHostPolicy: "verified-proxy-acl-v2",
    proxyConfiguration: { proxies: [{ externalProxy: { server: "proxy.internal", port: 8080 } }] },
    actionBudget: 500,
    maxSessionSeconds: 28_800,
    maxActionSeconds: 120,
    ...overrides,
  };
}

test("typed keys, pointer and scroll controls retain session owner and host guards", async () => {
  const store = new MemoryStore();
  const transport = new FakeTransport();
  const service = new CloudBrowserService(store, transport);
  await service.saveProfile("cto", {
    profileId: "cto-public",
    owner: "cto",
    allowedHosts: ["example.test"],
    persistent: false,
  });
  const { sessionId } = await service.start("cto", "cto-public", 60);
  await service.execute("cto", sessionId, { type: "press_key", key: "Enter" }, 2);
  await service.execute("cto", sessionId, { type: "scroll", x: 0, y: 0, deltaX: 0, deltaY: 100 }, 2);
  assert.equal(store.sessions.get(sessionId)?.actionsUsed, 2);
  const before = transport.actions.length;
  await assert.rejects(service.execute("cfo", sessionId, { type: "press_key", key: "Enter" }, 2), /unavailable/);
  await assert.rejects(service.execute("cto", sessionId, { type: "mouse_move", x: -1, y: 0 }, 2), (error: unknown) => error instanceof CloudBrowserError && error.code === "invalid_action");
  assert.equal(transport.actions.length, before);
  transport.execute = async () => ({
    url: "https://offpolicy.test/",
    title: "",
    visibleText: "",
  });
  await assert.rejects(service.execute("cto", sessionId, { type: "press_key", key: "Enter" }, 2), (error: unknown) => error instanceof CloudBrowserError && error.code === "redirect_outside_allowlist");
});

test("verified public-web profiles default omitted native-client budgets to the server cap and bound explicit budgets", async () => {
  const store = new MemoryStore();
  const transport = new FakeTransport();
  const service = new CloudBrowserService(store, transport, Date.now, TEST_PUBLIC_WEB_POLICY);
  store.profiles.set("cto-public-web", {
    profileId: "cto-public-web",
    owner: "cto",
    allowedHosts: [],
    persistent: false,
    mode: "public_web",
    customBrowserIdentifier: "browser-public-1",
    networkPolicyVersion: "egress-v3",
    privateHostPolicy: "verified-proxy-acl-v2",
    proxyConfiguration: {
      proxies: [{ externalProxy: { server: "proxy.internal", port: 8080 } }],
    },
    actionBudget: 500,
    maxSessionSeconds: 28_800,
    maxActionSeconds: 120,
  });
  const discovered = await service.publicWebProfile("cto");
  assert.equal(discovered.mode, "public_web");
  assert.deepEqual(discovered.allowedHosts, []);
  const legacyClient = await service.start('cto', 'cto-public-web', 28_800);
  assert.equal(store.sessions.get(legacyClient.sessionId)?.actionBudget, 500);
  await assert.rejects(service.start('cto', 'cto-public-web', 60, 501), (error: unknown) => error instanceof CloudBrowserError && error.code === 'invalid_action_budget');
  const { sessionId } = await service.start("cto", "cto-public-web", 28_800, 450);
  assert.equal(store.dailyReservations, 0, "public mode is not subject to the legacy daily trial limit");
  assert.equal(store.sessions.get(sessionId)?.actionBudget, 450);
  await service.execute("cto", sessionId, { type: "navigate", url: "http://news.example.org/path" }, 30);
  assert.equal(store.sessions.get(sessionId)?.actionsUsed, 1);
  await assert.rejects(service.execute("cto", sessionId, { type: "navigate", url: "https://user:pass@example.org/" }, 1), (e: unknown) => e instanceof CloudBrowserError && e.code === "host_forbidden");
  await assert.rejects(service.execute("cto", sessionId, { type: "navigate", url: "javascript:alert(1)" }, 1), (e: unknown) => e instanceof CloudBrowserError && e.code === "host_forbidden");
  const profileBeforeTamper = store.profiles.get('cto-public-web')!;
  store.profiles.set('cto-public-web', { ...profileBeforeTamper, privateHostPolicy: 'unverified' });
  const actionsBeforeTamper = transport.actions.length;
  await assert.rejects(service.execute('cto', sessionId, { type: 'navigate', url: 'https://news.example.org/' }, 1), (e: unknown) => e instanceof CloudBrowserError && e.code === 'public_network_policy_unverified');
  assert.equal(transport.actions.length, actionsBeforeTamper, 'a stale or changed policy must be rejected before provider use');
});

test("public mode fails closed unless trusted provisioning supplied the complete network boundary", async () => {
  const store = new MemoryStore();
  const service = new CloudBrowserService(store, new FakeTransport(), Date.now, TEST_PUBLIC_WEB_POLICY);
  store.profiles.set("cto-public-web", {
    profileId: "cto-public-web",
    owner: "cto",
    allowedHosts: [],
    persistent: false,
    mode: "public_web",
  });
  await assert.rejects(service.start("cto", "cto-public-web", 60, 10), (e: unknown) => e instanceof CloudBrowserError && e.code === "public_network_policy_unverified");
  await assert.rejects(service.saveProfile("cto", { profileId: "cto-public-web", owner: "cto", allowedHosts: [], persistent: false, mode: "public_web", customBrowserIdentifier: "browser-public", networkPolicyVersion: "egress-v3", privateHostPolicy: "proxy-acl-v2", proxyConfiguration: { proxies: [{ externalProxy: { server: "proxy.example.net", port: 8080 } }], bypass: { domainPatterns: [".example.net"] } }, actionBudget: 100, maxSessionSeconds: 180, maxActionSeconds: 30 }), (e: unknown) => e instanceof CloudBrowserError && e.code === "profile_provisioning_forbidden");
});

test("legacy enrolled-host profiles retain their strict hosts and daily-session accounting", async () => {
  const store = new MemoryStore();
  const service = new CloudBrowserService(store, new FakeTransport());
  await service.saveProfile("cto", {
    profileId: "cto-legacy",
    owner: "cto",
    allowedHosts: ["example.test"],
    persistent: false,
  });
  const legacySession = await service.start("cto", "cto-legacy", 180);
  assert.equal(store.dailyReservations, 1);
  await assert.rejects(service.execute("cto", legacySession.sessionId, { type: "navigate", url: "http://example.test/" }, 1), (e: unknown) => e instanceof CloudBrowserError && e.code === "host_forbidden");
  await assert.rejects(service.start("cto", "cto-legacy", 181), (e: unknown) => e instanceof CloudBrowserError && e.code === "invalid_duration");
});

test("cloud browser persists an opaque session and binds every operation to its caller", async () => {
  let now = 1_000_000;
  const store = new MemoryStore();
  const transport = new FakeTransport();
  const service = new CloudBrowserService(store, transport, () => now);
  await service.saveProfile("cto", {
    profileId: "cto-public",
    owner: "cto",
    allowedHosts: ["example.test"],
    persistent: true,
  });
  const started = await service.start("cto", "cto-public", 60);
  assert.deepEqual(Object.keys(started).sort(), ["expiresAt", "sessionId"]);
  assert.equal(store.sessions.get(started.sessionId)?.providerSessionId, "remote-session");
  await assert.rejects(
    () => service.execute("other", started.sessionId, { type: "navigate", url: "https://example.test/" }, 2),
    (e: unknown) => e instanceof CloudBrowserError && e.code === "owner_forbidden",
  );
  await service.execute("cto", started.sessionId, { type: "navigate", url: "https://example.test/" }, 2);
  assert.equal(transport.actions.length, 2, "navigation is prevalidated by URL and followed by a guarded current-page observation");
  now += 61_000;
  await assert.rejects(() => service.execute("cto", started.sessionId, { type: "navigate", url: "https://example.test/" }, 2), /expired/);
  await service.stop("cto", started.sessionId);
  assert.equal(transport.stopped, 1);
  assert.equal(store.sessions.has(started.sessionId), false);
});

test("cloud browser rejects hosts, uncontrolled selectors and over-budget action calls before transport", async () => {
  const store = new MemoryStore();
  const transport = new FakeTransport();
  const service = new CloudBrowserService(store, transport);
  await service.saveProfile("cto", {
    profileId: "cto-public",
    owner: "cto",
    allowedHosts: ["example.test"],
    persistent: false,
  });
  const { sessionId } = await service.start("cto", "cto-public", 60);
  await assert.rejects(
    () => service.execute("cto", sessionId, { type: "navigate", url: "https://evil.test/" }, 1),
    (e: unknown) => e instanceof CloudBrowserError && e.code === "host_forbidden",
  );
  await assert.rejects(
    () => service.execute("cto", sessionId, { type: "click", selector: "a\n#bad" }, 1),
    (e: unknown) => e instanceof CloudBrowserError && e.code === "invalid_action",
  );
  await assert.rejects(
    () => service.execute("cto", sessionId, { type: "wait_for", selector: "#ok" }, 21),
    (e: unknown) => e instanceof CloudBrowserError && e.code === "invalid_duration",
  );
  assert.equal(transport.actions.length, 0);
});

test("page actions return owned tab receipts and persist selection under the session lock", async () => {
  const store = new MemoryStore();
  const transport = new FakeTransport();
  const service = new CloudBrowserService(store, transport);
  await service.saveProfile("cto", {
    profileId: "cto-public",
    owner: "cto",
    allowedHosts: ["example.test"],
    persistent: false,
  });
  const { sessionId } = await service.start("cto", "cto-public", 60);
  const created = (await service.execute("cto", sessionId, { type: "tab_create", url: "https://example.test/new" } as never, 2)) as { createdTargetId?: string };
  assert.equal(created.createdTargetId, "new-owned");
  const selected = (await service.execute("cto", sessionId, { type: "tab_select", targetId: "new-owned" } as never, 2)) as { selectedTargetId?: string };
  assert.equal(selected.selectedTargetId, "new-owned");
  assert.deepEqual(store.sessions.get(sessionId)?.ownedTargetIds, ["initial-owned", "new-owned"]);
  assert.equal(store.sessions.get(sessionId)?.selectedTargetId, "new-owned");
});

test("unknown tab creation acknowledgement is persisted and blocks later effects", async () => {
  const store = new MemoryStore();
  const transport = new FakeTransport();
  const service = new CloudBrowserService(store, transport);
  await service.saveProfile("cto", {
    profileId: "cto-public",
    owner: "cto",
    allowedHosts: ["example.test"],
    persistent: false,
  });
  const { sessionId } = await service.start("cto", "cto-public", 60);
  transport.uncertainCreate = true;
  await assert.rejects(service.execute("cto", sessionId, { type: "tab_create", url: "https://example.test/new" } as never, 2), (error: unknown) => error instanceof CloudBrowserError && error.code === "target_create_uncertain");
  assert.equal(store.sessions.get(sessionId)?.effectUnknown, true);
  transport.uncertainCreate = false;
  const count = transport.actions.length;
  await assert.rejects(service.execute("cto", sessionId, { type: "press_key", key: "Enter" }, 2), (error: unknown) => error instanceof CloudBrowserError && error.code === "effect_unknown");
  assert.equal(transport.actions.length, count);
});

test("selecting a remaining owned tab works after the selected tab was closed", async () => {
  const store = new MemoryStore();
  const transport = new FakeTransport();
  const service = new CloudBrowserService(store, transport);
  await service.saveProfile("cto", {
    profileId: "cto-public",
    owner: "cto",
    allowedHosts: ["example.test"],
    persistent: false,
  });
  const { sessionId } = await service.start("cto", "cto-public", 60);
  const session = store.sessions.get(sessionId)!;
  session.ownedTargetIds = ["remaining-owned"];
  session.selectedTargetId = null;
  const result = (await service.execute("cto", sessionId, { type: "tab_select", targetId: "remaining-owned" } as never, 2)) as { selectedTargetId?: string };
  assert.equal(result.selectedTargetId, "remaining-owned");
});

test("closing the last selected tab allows creating and selecting a replacement tab", async () => {
  const store = new MemoryStore();
  const transport = new FakeTransport();
  const service = new CloudBrowserService(store, transport);
  await service.saveProfile("cto", {
    profileId: "cto-public",
    owner: "cto",
    allowedHosts: ["example.test"],
    persistent: false,
  });
  const { sessionId } = await service.start("cto", "cto-public", 60);
  await service.execute("cto", sessionId, { type: "snapshot" }, 2);
  const closed = (await service.execute("cto", sessionId, { type: "tab_close", targetId: "initial-owned" } as never, 2)) as { selectedTargetId?: string | null };
  assert.equal(closed.selectedTargetId, null);
  const created = (await service.execute("cto", sessionId, { type: "tab_create", url: "https://example.test/new" } as never, 2)) as { selectedTargetId?: string };
  assert.equal(created.selectedTargetId, "new-owned");
  const selected = (await service.execute("cto", sessionId, { type: "tab_select", targetId: "new-owned" } as never, 2)) as { selectedTargetId?: string };
  assert.equal(selected.selectedTargetId, "new-owned");
  assert.equal(store.sessions.get(sessionId)?.effectUnknown, false);
});

test("tab create intent and consumed action are durable before provider invocation", async () => {
  const store = new MemoryStore();
  const transport = new FakeTransport();
  const service = new CloudBrowserService(store, transport);
  await service.saveProfile("cto", {
    profileId: "cto-public",
    owner: "cto",
    allowedHosts: ["example.test"],
    persistent: false,
  });
  const { sessionId } = await service.start("cto", "cto-public", 60);
  const original = transport.execute.bind(transport);
  let sawIntent = false;
  transport.execute = async (session, action, timeout) => {
    if ((action as { type?: string }).type === "tab_create") {
      const durable = store.sessions.get(sessionId)!;
      sawIntent = durable.effectUnknown === true && durable.actionsUsed === 1;
    }
    return original(session, action, timeout);
  };
  await service.execute("cto", sessionId, { type: "tab_create", url: "https://example.test/new" } as never, 2);
  assert.equal(sawIntent, true);
  assert.equal(store.sessions.get(sessionId)?.effectUnknown, false);
  assert.equal(store.sessions.get(sessionId)?.actionsUsed, 1);
});

test("failed durable effect intent prevents tab creation from reaching the provider", async () => {
  const store = new MemoryStore();
  const transport = new FakeTransport();
  const service = new CloudBrowserService(store, transport);
  await service.saveProfile("cto", {
    profileId: "cto-public",
    owner: "cto",
    allowedHosts: ["example.test"],
    persistent: false,
  });
  const { sessionId } = await service.start("cto", "cto-public", 60);
  const save = store.saveSessionUnderLock.bind(store);
  store.saveSessionUnderLock = async (session, owner) => {
    if (session.effectUnknown) throw new Error("durable write failed");
    return save(session, owner);
  };
  const before = transport.actions.length;
  await assert.rejects(service.execute("cto", sessionId, { type: "tab_create", url: "https://example.test/new" } as never, 2), /durable write failed/);
  assert.equal(
    transport.actions.some((action) => (action as { type?: string }).type === "tab_create"),
    false,
  );
  assert.equal(transport.actions.length, before + 1, "only the safe preflight snapshot reached the provider");
});

test("CTO can provision one deterministic public profile per ordinary Chat lane, while callers discover only their own", async () => {
  const store = new MemoryStore();
  const service = new CloudBrowserService(store, new FakeTransport());
  const profile = await service.provisionPublicTrialProfile("cto", "cfo", ["Example.TEST"]);
  assert.deepEqual(profile, {
    profileId: "cfo-public-trial",
    owner: "cfo",
    allowedHosts: ["example.test"],
    persistent: false,
  });
  assert.deepEqual(await service.publicTrialProfile("cfo"), {
    profileId: "cfo-public-trial",
    allowedHosts: ["example.test"],
    persistent: false,
  });
  await assert.rejects(
    () => service.publicTrialProfile("cto"),
    (e: unknown) => e instanceof CloudBrowserError && e.code === "owner_forbidden",
  );
  await assert.rejects(
    () => service.provisionPublicTrialProfile("cfo", "coo", ["example.test"]),
    (e: unknown) => e instanceof CloudBrowserError && e.code === "provisioner_forbidden",
  );
  await assert.rejects(
    () => service.provisionPublicTrialProfile("cto", "clo-personal", ["example.test"]),
    (e: unknown) => e instanceof CloudBrowserError && e.code === "profile_owner_not_allowed",
  );
});

test("legacy discovery and old trial starts prefer this owner's verified public-web enrollment", async () => {
  const store = new MemoryStore();
  const transport = new FakeTransport();
  const service = new CloudBrowserService(store, transport, Date.now, TEST_PUBLIC_WEB_POLICY);
  const legacy: CloudBrowserProfile = {
    profileId: "cfo-public-trial",
    owner: "cfo",
    allowedHosts: ["example.test"],
    persistent: false,
  };
  const publicWeb = serverPublicWebProfile("cfo");
  store.profiles.set(legacy.profileId, legacy);
  store.profiles.set(publicWeb.profileId, publicWeb);

  assert.deepEqual(await service.publicTrialProfile("cfo"), {
    profileId: "cfo-public-web",
    allowedHosts: [],
    persistent: false,
  });
  const { sessionId } = await service.start("cfo", "cfo-public-trial", 60);
  const session = store.sessions.get(sessionId);
  assert.equal(session?.profileId, "cfo-public-web");
  assert.equal(session?.mode, "public_web");
  assert.deepEqual(transport.startedProfileIds, ["cfo:cfo-public-web"]);
  assert.equal(store.dailyReservations, 0);
  assert.deepEqual(store.profiles.get("cfo-public-trial"), legacy, "upgrade does not rewrite the old profile");
  assert.deepEqual(store.profiles.get("cfo-public-web"), publicWeb, "discovery/start do not modify the root enrollment");
});

test("legacy trial discovery and explicit starts fall back when no public-web enrollment exists", async () => {
  const store = new MemoryStore();
  const transport = new FakeTransport();
  const service = new CloudBrowserService(store, transport);
  const legacy: CloudBrowserProfile = {
    profileId: "cro-public-trial",
    owner: "cro",
    allowedHosts: ["example.test"],
    persistent: false,
  };
  store.profiles.set(legacy.profileId, legacy);

  assert.deepEqual(await service.publicTrialProfile("cro"), {
    profileId: "cro-public-trial",
    allowedHosts: ["example.test"],
    persistent: false,
  });
  const { sessionId } = await service.start("cro", "cro-public-trial", 60);
  assert.equal(store.sessions.get(sessionId)?.profileId, "cro-public-trial");
  assert.equal(store.sessions.get(sessionId)?.mode, "enrolled_hosts");
  assert.deepEqual(transport.startedProfileIds, ["cro:cro-public-trial"]);
  assert.equal(store.dailyReservations, 1);
});

test("legacy discovery preserves actual persistence metadata of an enrolled public-web profile", async () => {
  const store = new MemoryStore();
  const service = new CloudBrowserService(store, new FakeTransport(), Date.now, TEST_PUBLIC_WEB_POLICY);
  store.profiles.set("coo-public-web", serverPublicWebProfile("coo", { persistent: true, providerProfileId: "approved-opaque-profile" }));
  assert.deepEqual(await service.publicTrialProfile("coo"), { profileId: "coo-public-web", allowedHosts: [], persistent: true });
});

test("public-web resolution is owner-scoped and ignores unrelated profiles", async () => {
  const store = new MemoryStore();
  const transport = new FakeTransport();
  const service = new CloudBrowserService(store, transport, Date.now, TEST_PUBLIC_WEB_POLICY);
  const ctoPublicWeb = serverPublicWebProfile("cto");
  const cfoLegacy: CloudBrowserProfile = {
    profileId: "cfo-public-trial",
    owner: "cfo",
    allowedHosts: ["cfo.example.test"],
    persistent: false,
  };
  const croPublicWeb = serverPublicWebProfile("cro");
  store.profiles.set(ctoPublicWeb.profileId, ctoPublicWeb);
  store.profiles.set(cfoLegacy.profileId, cfoLegacy);
  store.profiles.set(croPublicWeb.profileId, croPublicWeb);

  assert.deepEqual(await service.publicTrialProfile("cfo"), {
    profileId: "cfo-public-trial",
    allowedHosts: ["cfo.example.test"],
    persistent: false,
  });
  await assert.rejects(
    service.start("cfo", "cto-public-trial", 60),
    (error: unknown) => error instanceof CloudBrowserError && error.code === "owner_forbidden",
  );
  await assert.rejects(
    service.publicTrialProfile("clo-personal"),
    (error: unknown) => error instanceof CloudBrowserError && error.code === "profile_not_enrolled",
  );
  assert.deepEqual(transport.startedProfileIds, []);
  assert.deepEqual(store.profiles.get("cto-public-web"), ctoPublicWeb, "another owner's profile is neither returned nor modified");
  assert.deepEqual(store.profiles.get("cro-public-web"), croPublicWeb, "unrelated enrollments are not enumerated");
});

test("an invalid server-enrolled public-web record fails closed instead of downgrading to the old trial", async () => {
  const store = new MemoryStore();
  const transport = new FakeTransport();
  const service = new CloudBrowserService(store, transport, Date.now, TEST_PUBLIC_WEB_POLICY);
  store.profiles.set("developer-public-trial", {
    profileId: "developer-public-trial",
    owner: "developer",
    allowedHosts: ["example.test"],
    persistent: false,
  });
  store.profiles.set("developer-public-web", serverPublicWebProfile("developer", { proxyConfiguration: undefined }));

  await assert.rejects(
    service.publicTrialProfile("developer"),
    (error: unknown) => error instanceof CloudBrowserError && error.code === "public_network_policy_unverified",
  );
  await assert.rejects(
    service.start("developer", "developer-public-trial", 60),
    (error: unknown) => error instanceof CloudBrowserError && error.code === "public_network_policy_unverified",
  );
  assert.equal(store.dailyReservations, 0);
  assert.equal(store.sessions.size, 0);
  assert.deepEqual(transport.startedProfileIds, []);
});

test("session action lease fences concurrent gateway copies and preserves action increments", async () => {
  const store = new MemoryStore();
  let release!: () => void;
  const entered = new Promise<void>((resolve) => {
    release = resolve;
  });
  const transport = new FakeTransport();
  transport.execute = async (_s, action) => {
    transport.actions.push(action);
    await entered;
    return typeof action === "object" && action !== null && (action as { type?: unknown }).type === "snapshot" ? { url: "https://example.test/", title: "Example", visibleText: "" } : null;
  };
  const service = new CloudBrowserService(store, transport);
  await service.saveProfile("cto", {
    profileId: "cto-public",
    owner: "cto",
    allowedHosts: ["example.test"],
    persistent: false,
  });
  const { sessionId } = await service.start("cto", "cto-public", 60);
  const first = service.execute("cto", sessionId, { type: "wait_for", selector: "#ok" }, 1);
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(
    () => service.execute("cto", sessionId, { type: "wait_for", selector: "#ok" }, 1),
    (e: unknown) => e instanceof CloudBrowserError && e.code === "session_busy",
  );
  release();
  await first;
  assert.equal(store.sessions.get(sessionId)?.actionsUsed, 1);
});

test('capture is a locked budgeted action and returns only an owner-bound opaque reference', async () => {
  const store = new MemoryStore();
  const service = new CloudBrowserService(store, new FakeTransport(), () => 1234);
  await service.saveProfile('cto', { profileId: 'cto-capture', owner: 'cto', allowedHosts: ['example.test'], persistent: false });
  const { sessionId } = await service.start('cto', 'cto-capture', 60);
  const result = await service.execute('cto', sessionId, { type: 'capture', request: { type: 'screenshot', format: 'png' } }, 5) as BrowserCaptureMetadata;
  assert.equal(result.id, 'bca_123e4567-e89b-42d3-a456-426614174000');
  assert.equal(result.owner, 'cto');
  assert.equal(result.contentType, 'image/png');
  assert.equal('body' in result, false);
  assert.equal(store.sessions.get(sessionId)?.actionsUsed, 1);
  assert.equal((await service.getCapture('cto', result.id)).body.byteLength, result.byteLength);
  await assert.rejects(service.getCapture('cfo', result.id), (e: unknown) => e instanceof CloudBrowserError && e.code === 'owner_forbidden');
});

test('capture fails closed for persisted profiles, sensitive suppression, and exhausted action budgets', async () => {
  const store = new MemoryStore();
  const transport = new FakeTransport();
  const service = new CloudBrowserService(store, transport);
  await service.saveProfile('cto', { profileId: 'cto-persist', owner: 'cto', allowedHosts: ['example.test'], persistent: true, providerProfileId: 'provider-profile' });
  const persisted = await service.start('cto', 'cto-persist', 60);
  const before = transport.actions.length;
  await assert.rejects(service.execute('cto', persisted.sessionId, { type: 'capture', request: { type: 'pdf' } }, 5), (e: unknown) => e instanceof CloudBrowserError && e.code === 'sensitive_output_denied');
  assert.equal(transport.actions.length, before);

  await service.saveProfile('cto', { profileId: 'cto-public-capture', owner: 'cto', allowedHosts: ['example.test'], persistent: false });
  const fresh = await service.start('cto', 'cto-public-capture', 60);
  await service.beginSensitiveOutputSuppression('cto', fresh.sessionId);
  await assert.rejects(service.execute('cto', fresh.sessionId, { type: 'capture', request: { type: 'screenshot' } }, 5), (e: unknown) => e instanceof CloudBrowserError && e.code === 'sensitive_output_denied');
  await service.endSensitiveOutputSuppression('cto', fresh.sessionId);
  store.sessions.set(fresh.sessionId, { ...store.sessions.get(fresh.sessionId)!, actionsUsed: 20 });
  await assert.rejects(service.execute('cto', fresh.sessionId, { type: 'capture', request: { type: 'screenshot' } }, 5), (e: unknown) => e instanceof CloudBrowserError && e.code === 'action_limit');
});
