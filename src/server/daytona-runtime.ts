import type { FastifyInstance } from 'fastify';
import { logger } from '../audit/logger.js';
import { DaytonaApiBrowserProvider, type DaytonaApiBrowserProviderOptions, type DaytonaViewerGrantPort } from '../tools/browser-daytona/client.js';
import { DaytonaBrowserError, type DaytonaBrowserStore, type DaytonaProvider } from '../tools/browser-daytona/contract.js';
import { DaytonaBrowserService } from '../tools/browser-daytona/service.js';
import { assertDaytonaBinding, assertDaytonaMission, DynamoDaytonaBrowserStore } from '../tools/browser-daytona/store.js';
import { EncryptedDaytonaViewerGrantPort } from '../tools/browser-daytona/viewer-grants.js';
import { DynamoDaytonaViewerGrantStore, type DaytonaViewerGrantStore } from '../tools/browser-daytona/viewer-grant-store.js';
import { DaytonaViewerExpiryController, type DaytonaViewerExpiryResult } from '../tools/browser-daytona/viewer-expiry.js';
import type { DaytonaGatewayAdapter, DaytonaGatewayRuntime } from '../tools/browser-cloud-gateway/index.js';
import { DaytonaViewerHandoffService, DynamoDaytonaViewerTicketStore, type DaytonaViewerTicketStore } from './daytona-viewer-service.js';
import { registerDaytonaViewerRoutes, type DaytonaViewerOptions, type DaytonaViewerService } from './daytona-viewer.js';
import { createConfiguredDaytonaArtifactPorts } from './daytona-artifact-ports.js';

type CapableProvider = DaytonaProvider & { capabilities: Readonly<{ checkpoint: boolean }> };
export interface DaytonaRuntimeDependencies {
  env?: NodeJS.ProcessEnv;
  /** Trusted boot/test composition only. Never supplied by a tool/route caller. */
  resolveApiToken?: () => Promise<string>;
  viewer?: () => DaytonaViewerGrantPort | undefined;
  createProvider?: (options: DaytonaApiBrowserProviderOptions) => CapableProvider;
  createStore?: () => DaytonaBrowserStore;
  createTickets?: () => DaytonaViewerTicketStore;
  createGrantStore?: () => DaytonaViewerGrantStore;
  scheduleTick?: (tick: () => void, milliseconds: 1000) => () => void;
  onWatchdogStatus?: (result: DaytonaViewerExpiryResult) => void;
}
export interface DaytonaRuntimeController {
  adapter: DaytonaGatewayAdapter;
  status(): { optedIn: boolean; configured: boolean; watchdogReady: boolean; missing: string[] };
  initialize(): Promise<boolean>;
  shutdown(): void;
  registerRoutes(app: FastifyInstance): Promise<boolean>;
}
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
function fail(code: string): never { throw new DaytonaBrowserError(code); }

/** No resources, profiles or bindings are provisioned. Merely importing this
 * module or constructing a controller NEVER starts timers/provider actions. */
export function createDaytonaRuntimeController(dependencies: DaytonaRuntimeDependencies = {}): DaytonaRuntimeController {
  const env = dependencies.env ?? process.env;
  const table = () => env.DAYTONA_BROWSER_DDB_TABLE ?? env.CLOUD_BROWSER_DDB_TABLE;
  const grantTable = () => env.DAYTONA_VIEWER_GRANT_DDB_TABLE ?? table();
  const region = () => env.AWS_REGION ?? 'us-east-1';
  const token = (): string => {
    const value = env.DAYTONA_BROWSER_API_TOKEN;
    if (typeof value !== 'string' || !/^[\x21-\x7e]{16,4096}$/.test(value)) return fail('daytona_api_token_unavailable'); return value;
  };
  const resolveApiToken = dependencies.resolveApiToken ?? (async () => token());
  const origins = (): readonly string[] => {
    const values: unknown = JSON.parse(env.DAYTONA_BROWSER_TOOLBOX_ALLOWED_ORIGINS ?? 'null');
    if (!Array.isArray(values) || !values.length || values.length > 4 || !values.every(value => {
      if (typeof value !== 'string') return false;
      try { const url = new URL(value); return url.protocol === 'https:' && url.origin === value && !url.username && !url.password && !url.port; } catch { return false; }
    })) return fail('daytona_toolbox_origin_unavailable'); return values as string[];
  };
  const grantKey = (): Buffer => {
    const value = env.DAYTONA_VIEWER_GRANT_KEY_BASE64;
    if (typeof value !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(value)) return fail('daytona_viewer_key_unavailable');
    const key = Buffer.from(value, 'base64');
    if (key.length !== 32 || key.toString('base64') !== value || new Set(key).size < 8) { key.fill(0); return fail('daytona_viewer_key_unavailable'); } return key;
  };
  const commonMissing = (): string[] => {
    const missing: string[] = [];
    if (!/^[A-Za-z0-9_.-]{3,255}$/.test(table() ?? '')) missing.push('DAYTONA_BROWSER_DDB_TABLE');
    if (!/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/.test(region())) missing.push('AWS_REGION');
    try { const url = new URL(env.DAYTONA_BROWSER_API_BASE_URL ?? ''); if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.port) throw new Error(); }
    catch { missing.push('DAYTONA_BROWSER_API_BASE_URL'); }
    if (!UUID.test(env.DAYTONA_BROWSER_ORGANIZATION_ID ?? '')) missing.push('DAYTONA_BROWSER_ORGANIZATION_ID');
    if (!dependencies.resolveApiToken) { try { token(); } catch { missing.push('DAYTONA_BROWSER_API_TOKEN'); } }
    try { origins(); } catch { missing.push('DAYTONA_BROWSER_TOOLBOX_ALLOWED_ORIGINS'); } return missing;
  };
  const viewerOptions = (): DaytonaViewerOptions => {
    const previewDomain = env.DAYTONA_BROWSER_PREVIEW_DOMAIN ?? '', previewPort = Number(env.DAYTONA_BROWSER_PREVIEW_PORT), viewerPath = env.DAYTONA_BROWSER_PREVIEW_PATH ?? '';
    if (!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(previewDomain) || !Number.isInteger(previewPort) || previewPort < 1 || previewPort > 65535
      || !/^\/[A-Za-z0-9_./-]+$/.test(viewerPath) || viewerPath.includes('..')) return fail('daytona_viewer_configuration_missing'); return { previewDomain, previewPort, viewerPath };
  };
  const humanMissing = (): string[] => {
    const missing: string[] = [];
    if (!UUID.test(env.DAYTONA_BROWSER_SANDBOX_ID ?? '')) missing.push('DAYTONA_BROWSER_SANDBOX_ID');
    if (!/^[A-Za-z0-9_.-]{3,255}$/.test(grantTable() ?? '')) missing.push('DAYTONA_VIEWER_GRANT_DDB_TABLE');
    if (!/^[a-f0-9]{64}$/.test(env.DAYTONA_BROWSER_VIEWER_CONTROL_SHA256 ?? '')) missing.push('DAYTONA_BROWSER_VIEWER_CONTROL_SHA256');
    try { grantKey().fill(0); } catch { missing.push('DAYTONA_VIEWER_GRANT_KEY_BASE64'); }
    try { viewerOptions(); } catch { missing.push('DAYTONA_BROWSER_PREVIEW_DOMAIN/PORT/PATH'); } return missing;
  };
  let ownedStore: DaytonaBrowserStore | undefined;
  const sessionStore = () => ownedStore ??= dependencies.createStore?.() ?? new DynamoDaytonaBrowserStore({ tableName: table(), region: region() });
  let expiry: DaytonaViewerExpiryController | undefined, cancelTick: (() => void) | undefined, initializing: Promise<boolean> | undefined;
  let running = false, closed = false, lastAttention = '';
  const expiryReady = () => !closed && running && expiry?.ready() === true;
  const status = () => {
    const missing = [...commonMissing(), ...humanMissing()]; if (env.DAYTONA_BROWSER_ENABLED !== 'true') missing.unshift('DAYTONA_BROWSER_ENABLED');
    return { optedIn: env.DAYTONA_BROWSER_ENABLED === 'true', configured: missing.length === 0, watchdogReady: expiryReady(), missing };
  };
  const requireExpiry = () => { if (!expiryReady()) fail('daytona_viewer_expiry_unavailable'); };
  type Runtime = DaytonaGatewayRuntime & { viewers: Pick<DaytonaViewerHandoffService, 'issue'> & DaytonaViewerService };
  let instance: Runtime | undefined;
  const build = (): Runtime => {
    if (instance) return instance; if (commonMissing().length) return fail('daytona_not_configured');
    let viewer: DaytonaViewerGrantPort | undefined;
    if (!humanMissing().length) {
      const options = viewerOptions(), store = dependencies.createGrantStore?.() ?? new DynamoDaytonaViewerGrantStore({ tableName: grantTable()!, region: region() });
      const key = grantKey();
      try { viewer = dependencies.viewer?.() ?? new EncryptedDaytonaViewerGrantPort({ store, apiBaseUrl: env.DAYTONA_BROWSER_API_BASE_URL!, organizationId: env.DAYTONA_BROWSER_ORGANIZATION_ID!, resolveApiToken, encryptionKey: key, previewDomain: options.previewDomain, previewPort: options.previewPort, previewPath: options.viewerPath, viewerControlSha256: env.DAYTONA_BROWSER_VIEWER_CONTROL_SHA256!, toolboxAllowedOrigins: origins() }); }
      finally { key.fill(0); }
      expiry = new DaytonaViewerExpiryController({ store, port: viewer, organizationId: env.DAYTONA_BROWSER_ORGANIZATION_ID!, sandboxId: env.DAYTONA_BROWSER_SANDBOX_ID! });
    }
    const provider = (dependencies.createProvider ?? (options => new DaytonaApiBrowserProvider(options)))({ apiBaseUrl: env.DAYTONA_BROWSER_API_BASE_URL!, organizationId: env.DAYTONA_BROWSER_ORGANIZATION_ID!, resolveApiToken, toolboxAllowedOrigins: origins(), ...createConfiguredDaytonaArtifactPorts({ env }), ...(viewer ? { viewer } : {}) });
    const store = sessionStore(), service = new DaytonaBrowserService(store, provider);
    const approved = async (caller: string, profile: string, principal?: string) => {
      const binding = await store.loadBinding(profile); assertDaytonaBinding(binding);
      if (binding.profileKey !== profile || binding.owner !== caller || binding.ownerSubjectHash !== principal || binding.sandboxId !== env.DAYTONA_BROWSER_SANDBOX_ID) fail('owner_forbidden');
    };
    const browser: DaytonaGatewayRuntime['browser'] = {
      discover: service.discover.bind(service),
      readiness: async (caller, profile, principal) => { requireExpiry(); await approved(caller, profile, principal); return service.readiness(caller, profile, principal); },
      start: async (caller, profile, seconds, budget, principal) => { requireExpiry(); await approved(caller, profile, principal); return service.start(caller, profile, seconds, budget, principal); },
      execute: service.execute.bind(service), snapshot: service.snapshot.bind(service), savePersistentProfile: service.savePersistentProfile.bind(service), stop: service.stop.bind(service),
    };
    const grantPreflight = async (caller: string, id: string, principal: string) => {
      requireExpiry(); const session = await store.loadSession(id); assertDaytonaMission(session);
      if (session.sessionId !== id || session.owner !== caller || session.ownerSubjectHash !== principal || session.sandboxId !== env.DAYTONA_BROWSER_SANDBOX_ID) fail('owner_forbidden');
      const readiness = await browser.readiness(caller, session.profileKey, principal); if (readiness.checkpointReady !== true) fail('daytona_checkpoint_unavailable');
    };
    const tickets = dependencies.createTickets?.() ?? new DynamoDaytonaViewerTicketStore({ tableName: table(), region: region() });
    const handoff = new DaytonaViewerHandoffService(tickets, {
      loadSession: id => store.loadSession(id),
      getViewerGrant: async (caller, id, principal, seconds) => { await grantPreflight(caller, id, principal); return service.getViewerGrant(caller, id, principal, seconds); },
      resumeViewerGrant: service.resumeViewerGrant.bind(service), completeHumanInput: service.completeHumanInput.bind(service), stop: service.stop.bind(service),
    });
    const viewers = { issue: async (...args: Parameters<DaytonaViewerHandoffService['issue']>) => { requireExpiry(); return handoff.issue(...args); },
      exchange: async (token: string) => { requireExpiry(); return handoff.exchange(token); }, resume: async (token: string) => { requireExpiry(); return handoff.resume(token); },
      // Cleanup remains possible after scheduler/config degradation. Health is
      // NOT a human-input-revoked receipt; the core still owns all mission fences.
      complete: handoff.complete.bind(handoff), expire: handoff.expire.bind(handoff) };
    return instance = { browser, viewers, capabilities: Object.freeze({ checkpoint: provider.capabilities.checkpoint === true, humanViewer: Boolean(viewer) }) };
  };
  const runTick = async () => {
    if (!running || !expiry) return;
    const result = await expiry.tick(); dependencies.onWatchdogStatus?.(result);
    const attention = result.status === 'operator_attention' ? result.reason : '';
    if (attention && attention !== lastAttention) logger.warn({ type: 'daytona_viewer_expiry', status: 'operator_attention', reason: attention }, 'Daytona viewer expiry requires owned operator reconciliation');
    lastAttention = attention;
  };
  const initialize = async (): Promise<boolean> => {
    if (closed || !status().configured) return false; if (running && !initializing) return expiryReady(); if (initializing) return initializing;
    initializing = (async () => {
      build(); running = true; await runTick();
      if (!closed) {
        const callback = () => { void runTick().catch(() => undefined); };
        cancelTick = dependencies.scheduleTick?.(callback, 1000) ?? (() => { const timer = setInterval(callback, 1000); timer.unref(); return () => clearInterval(timer); })();
      }
      return expiryReady();
    })();
    try { return await initializing; }
    catch { running = false; cancelTick?.(); cancelTick = undefined; return false; }
    finally { initializing = undefined; }
  };
  const shutdown = () => { closed = true; running = false; cancelTick?.(); cancelTick = undefined; };
  const adapter: DaytonaGatewayAdapter = {
    get: async () => status().configured && expiryReady() ? build() : undefined,
    forSession: async id => {
      if (!UUID.test(id) || !table()) return undefined;
      const session = await sessionStore().loadSession(id); if (!session) return undefined; assertDaytonaMission(session);
      if (session.sessionId !== id) return fail('owner_forbidden');
      // A sealed record or failed lookup never falls through to AWS, including
      // when opt-out/capability downgrade requires exact-owned cleanup only.
      return build();
    },
  };
  const registered = new WeakSet<FastifyInstance>();
  return { adapter, status, initialize, shutdown, registerRoutes: async app => {
    if (registered.has(app)) return true; if (!status().configured || closed) return false;
    await initialize(); registerDaytonaViewerRoutes(app, () => build().viewers, viewerOptions());
    app.addHook('onClose', async () => { shutdown(); }); registered.add(app); return true;
  } };
}

let viewerPort: DaytonaViewerGrantPort | undefined;
export function installDaytonaViewerGrantPort(port: DaytonaViewerGrantPort): void {
  if (viewerPort || !port || typeof port.mint !== 'function' || typeof port.read !== 'function' || typeof port.revoke !== 'function') return fail('daytona_viewer_port_invalid'); viewerPort = port;
}
const production = createDaytonaRuntimeController({ viewer: () => viewerPort });
export const daytonaGatewayAdapter = production.adapter;
export const daytonaRuntimeStatus = production.status;
export const registerConfiguredDaytonaViewerRoutes = production.registerRoutes;
export const initializeDaytonaRuntime = production.initialize;
export const shutdownDaytonaRuntime = production.shutdown;
