import type { FastifyInstance } from 'fastify';
import { DaytonaApiBrowserProvider, type DaytonaApiBrowserProviderOptions, type DaytonaViewerGrantPort } from '../tools/browser-daytona/client.js';
import { DaytonaBrowserError, type DaytonaBrowserStore, type DaytonaProvider } from '../tools/browser-daytona/contract.js';
import { DaytonaBrowserService } from '../tools/browser-daytona/service.js';
import { assertDaytonaMission, DynamoDaytonaBrowserStore } from '../tools/browser-daytona/store.js';
import type { DaytonaGatewayAdapter, DaytonaGatewayRuntime } from '../tools/browser-cloud-gateway/index.js';
import { DaytonaViewerHandoffService, DynamoDaytonaViewerTicketStore, type DaytonaViewerTicketStore } from './daytona-viewer-service.js';
import { registerDaytonaViewerRoutes, type DaytonaViewerOptions } from './daytona-viewer.js';

type CapableProvider = DaytonaProvider & { capabilities: Readonly<{ checkpoint: boolean }> };
export interface DaytonaRuntimeDependencies {
  env?: NodeJS.ProcessEnv;
  /** Server boot composition only; never provided by a tool/route caller. */
  resolveApiToken?: () => Promise<string>;
  viewer?: () => DaytonaViewerGrantPort | undefined;
  createProvider?: (options: DaytonaApiBrowserProviderOptions) => CapableProvider;
  createStore?: () => DaytonaBrowserStore;
  createTickets?: () => DaytonaViewerTicketStore;
}
export interface DaytonaRuntimeController {
  adapter: DaytonaGatewayAdapter;
  status(): { optedIn: boolean; configured: boolean; missing: string[] };
  registerRoutes(app: FastifyInstance): Promise<boolean>;
}

/** No resources, profiles or bindings are provisioned by this optional runtime. */
export function createDaytonaRuntimeController(dependencies: DaytonaRuntimeDependencies = {}): DaytonaRuntimeController {
  const env = dependencies.env ?? process.env;
  const table = () => env.DAYTONA_BROWSER_DDB_TABLE ?? env.CLOUD_BROWSER_DDB_TABLE;
  const region = () => env.AWS_REGION ?? 'us-east-1';
  const token = (): string => {
    const value = env.DAYTONA_BROWSER_API_TOKEN;
    if (typeof value !== 'string' || !/^[\x21-\x7e]{16,4096}$/.test(value)) throw new DaytonaBrowserError('daytona_api_token_unavailable');
    return value;
  };
  const commonMissing = (): string[] => {
    const missing: string[] = [];
    if (!/^[A-Za-z0-9_.-]{3,255}$/.test(table() ?? '')) missing.push('DAYTONA_BROWSER_DDB_TABLE');
    if (!/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/.test(region())) missing.push('AWS_REGION');
    try { const url = new URL(env.DAYTONA_BROWSER_API_BASE_URL ?? ''); if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || (url.port && url.port !== '443')) throw new Error(); }
    catch { missing.push('DAYTONA_BROWSER_API_BASE_URL'); }
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(env.DAYTONA_BROWSER_ORGANIZATION_ID ?? '')) missing.push('DAYTONA_BROWSER_ORGANIZATION_ID');
    if (!dependencies.resolveApiToken) { try { token(); } catch { missing.push('DAYTONA_BROWSER_API_TOKEN'); } }
    try { origins(); } catch { missing.push('DAYTONA_BROWSER_TOOLBOX_ALLOWED_ORIGINS'); }
    return missing;
  };
  const origins = (): readonly string[] => {
    const values: unknown = JSON.parse(env.DAYTONA_BROWSER_TOOLBOX_ALLOWED_ORIGINS ?? 'null');
    if (!Array.isArray(values) || !values.length || values.length > 4 || !values.every(value => {
      if (typeof value !== 'string') return false;
      try { const url = new URL(value); return url.protocol === 'https:' && url.origin === value && !url.username && !url.password && !url.port; } catch { return false; }
    })) throw new DaytonaBrowserError('daytona_toolbox_origin_unavailable');
    return values as string[];
  };
  const viewerOptions = (): DaytonaViewerOptions => {
    const previewDomain = env.DAYTONA_BROWSER_PREVIEW_DOMAIN ?? '', previewPort = Number(env.DAYTONA_BROWSER_PREVIEW_PORT), viewerPath = env.DAYTONA_BROWSER_PREVIEW_PATH ?? '';
    if (!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(previewDomain) || !Number.isInteger(previewPort) || previewPort < 1 || previewPort > 65535
      || !/^\/[A-Za-z0-9_./-]+$/.test(viewerPath) || viewerPath.includes('..')) throw new DaytonaBrowserError('daytona_viewer_configuration_missing');
    return { previewDomain, previewPort, viewerPath };
  };
  const status = () => {
    const missing = commonMissing();
    if (env.DAYTONA_BROWSER_ENABLED !== 'true') missing.unshift('DAYTONA_BROWSER_ENABLED');
    if (!dependencies.viewer?.()) missing.push('encrypted_viewer_grant_port');
    try { viewerOptions(); } catch { missing.push('DAYTONA_BROWSER_PREVIEW_DOMAIN/PORT/PATH'); }
    return { optedIn: env.DAYTONA_BROWSER_ENABLED === 'true', configured: missing.length === 0, missing };
  };
  let store: DaytonaBrowserStore | undefined;
  const sessionStore = () => store ??= dependencies.createStore?.() ?? new DynamoDaytonaBrowserStore({ tableName: table(), region: region() });
  type Runtime = DaytonaGatewayRuntime & { browser: DaytonaBrowserService; viewers: DaytonaViewerHandoffService };
  let instance: Runtime | undefined;
  const build = (): Runtime => {
    if (instance) return instance;
    if (commonMissing().length) throw new DaytonaBrowserError('daytona_not_configured');
    const viewer = dependencies.viewer?.();
    const provider = (dependencies.createProvider ?? (options => new DaytonaApiBrowserProvider(options)))({
      apiBaseUrl: env.DAYTONA_BROWSER_API_BASE_URL!, organizationId: env.DAYTONA_BROWSER_ORGANIZATION_ID!,
      resolveApiToken: dependencies.resolveApiToken ?? (async () => token()), toolboxAllowedOrigins: origins(), ...(viewer ? { viewer } : {}),
    });
    const ownedStore = sessionStore(), browser = new DaytonaBrowserService(ownedStore, provider);
    const tickets = dependencies.createTickets?.() ?? new DynamoDaytonaViewerTicketStore({ tableName: table(), region: region() });
    const viewers = new DaytonaViewerHandoffService(tickets, {
      loadSession: id => ownedStore.loadSession(id), getViewerGrant: browser.getViewerGrant.bind(browser), resumeViewerGrant: browser.resumeViewerGrant.bind(browser), completeHumanInput: browser.completeHumanInput.bind(browser), stop: browser.stop.bind(browser),
    });
    return instance = { browser, viewers, capabilities: Object.freeze({ checkpoint: provider.capabilities.checkpoint === true, humanViewer: Boolean(viewer) }) };
  };
  const adapter: DaytonaGatewayAdapter = {
    get: async () => status().configured ? build() : undefined,
    forSession: async id => {
      if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id) || !table()) return undefined;
      // Keep sealed routing/cleanup for existing missions even after opt-out or
      // capability downgrade. A found record or failed lookup never selects AWS.
      const session = await sessionStore().loadSession(id);
      if (!session) return undefined;
      assertDaytonaMission(session);
      if (session.sessionId !== id) throw new DaytonaBrowserError('owner_forbidden');
      return build();
    },
  };
  return { adapter, status, registerRoutes: async app => {
    const configured = await adapter.get();
    if (!configured || !configured.capabilities.checkpoint || !configured.capabilities.humanViewer) return false;
    registerDaytonaViewerRoutes(app, () => build().viewers, viewerOptions()); return true;
  } };
}

// A private server-side grant vault/revoker must be installed explicitly at boot.
// Merely adding an API key cannot enable a human handoff or fake a checkpoint.
let viewerPort: DaytonaViewerGrantPort | undefined;
export function installDaytonaViewerGrantPort(port: DaytonaViewerGrantPort): void {
  if (viewerPort || !port || typeof port.mint !== 'function' || typeof port.read !== 'function' || typeof port.revoke !== 'function') throw new DaytonaBrowserError('daytona_viewer_port_invalid');
  viewerPort = port;
}
const production = createDaytonaRuntimeController({ viewer: () => viewerPort });
export const daytonaGatewayAdapter = production.adapter;
export const daytonaRuntimeStatus = production.status;
export const registerConfiguredDaytonaViewerRoutes = production.registerRoutes;

