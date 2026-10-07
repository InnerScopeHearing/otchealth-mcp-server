import test from 'node:test';
import assert from 'node:assert/strict';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CloudBrowserService } from '../browser-cloud/service.js';
import type { CloudBrowserProfile, CloudBrowserProviderProfile, CloudBrowserSession, CloudBrowserStore, CloudBrowserTransport } from '../browser-cloud/contract.js';
import { registerCloudBrowserTools, type CloudBrowserGatewayRuntime } from './index.js';
import type { registerTool } from '../registry.js';

class Store implements CloudBrowserStore {
  readonly profiles = new Map<string, CloudBrowserProfile>();
  async loadProfile(id: string): Promise<CloudBrowserProfile | null> { return this.profiles.get(id) ?? null; }
  async saveProfile(value: CloudBrowserProfile): Promise<void> { this.profiles.set(value.profileId, value); }
  async saveProfileIfAbsent(value: CloudBrowserProfile): Promise<boolean> { if (this.profiles.has(value.profileId)) return false; this.profiles.set(value.profileId, value); return true; }
  async loadSession(): Promise<null> { return null; }
  async saveSession(_value: CloudBrowserSession): Promise<void> {}
  async saveSessionUnderLock(_value: CloudBrowserSession, _owner: string): Promise<void> {}
  async deleteSession(_id: string): Promise<void> {}
  async acquireSessionLock(): Promise<boolean> { return true; }
  async releaseSessionLock(): Promise<void> {}
  async acquireProfileLock(): Promise<boolean> { return true; }
  async releaseProfileLock(): Promise<void> {}
  async reserveDailySession(): Promise<boolean> { return true; }
}

class Transport implements CloudBrowserTransport {
  profileReads = 0;
  readonly profile: CloudBrowserProviderProfile = { profileId: 'otchealth_cto_cloud-dVDhGycboH', name: 'otchealth_cto_cloud', status: 'READY',
    profileArn: 'arn:aws:bedrock-agentcore:us-east-1:900915535335:browser-profile/otchealth_cto_cloud-dVDhGycboH',
    lastSavedAt: '2026-09-21T02:41:19.395091Z', lastSavedBrowserId: 'aws.browser.v1' };
  async getBrowserProfile(): Promise<CloudBrowserProviderProfile> { this.profileReads += 1; return this.profile; }
  async start(): Promise<Pick<CloudBrowserSession, 'providerSessionId' | 'automationEndpoint'>> { throw new Error('not used'); }
  async execute(): Promise<null> { throw new Error('not used'); }
  async stop(): Promise<void> {}
}

test('registered CTO handler binds through service/store/transport while other lane stays on public trial', async (t) => {
  const prior = { ...process.env };
  t.after(() => { process.env = prior; });
  process.env.CLOUD_BROWSER_ENABLED = 'true'; process.env.CLOUD_BROWSER_DDB_TABLE = 'synthetic';
  process.env.CLOUD_BROWSER_QUEUE_URL = 'https://sqs.us-east-1.amazonaws.com/900915535335/synthetic';
  process.env.CLOUD_BROWSER_ARTIFACT_BUCKET = 'synthetic';

  const store = new Store(); const transport = new Transport();
  await store.saveProfile({ profileId: 'cfo-public-trial', owner: 'cfo', allowedHosts: ['example.test'], persistent: false });
  const service = new CloudBrowserService(store, transport, Date.now, { profileId: 'otchealth_cto_cloud-dVDhGycboH', name: 'otchealth_cto_cloud',
    accountId: '900915535335', region: 'us-east-1', browserIdentifier: 'aws.browser.v1', allowedHosts: ['example.test'] });
  const runtime = { browser: service } as unknown as CloudBrowserGatewayRuntime;
  const tools = new Map<string, { handler: (input: Record<string, never>, context: { callerAgent: string; dryRun: boolean }) => Promise<{ data: Record<string, unknown> }> }>();
  const registrar = ((_server: unknown, definition: { name: string; handler: (input: Record<string, never>, context: { callerAgent: string; dryRun: boolean }) => Promise<{ data: Record<string, unknown> }> }) => {
    tools.set(definition.name, definition);
  }) as typeof registerTool;
  registerCloudBrowserTools({} as McpServer, (() => 'synthetic-caller-hash'), runtime, registrar);

  const publicDiscovery = await tools.get('browser_cloud_profile_discover')!.handler({}, { callerAgent: 'cfo', dryRun: false });
  assert.deepEqual(publicDiscovery.data, { profile_id: 'cfo-public-trial', allowed_hosts: ['example.test'], persistent: false });
  const bind = tools.get('browser_cloud_cto_profile_bind_existing')!.handler;
  const denied = await bind({}, { callerAgent: 'cfo', dryRun: false });
  assert.equal(denied.data.error, 'owner_forbidden'); assert.equal(transport.profileReads, 0);
  const dryRun = await bind({}, { callerAgent: 'cto', dryRun: true });
  assert.equal(dryRun.data.dry_run, true); assert.equal(transport.profileReads, 0);
  const result = await bind({}, { callerAgent: 'cto', dryRun: false });
  assert.equal(result.data.profile_id, transport.profile.profileId);
  assert.equal(result.data.status, 'READY');
  assert.equal(transport.profileReads, 1);
  assert.equal(store.profiles.get(transport.profile.profileId)?.owner, 'cto');
  assert.equal(store.profiles.get('cfo-public-trial')?.persistent, false);
});
