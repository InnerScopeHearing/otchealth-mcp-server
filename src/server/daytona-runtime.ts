import type { FastifyInstance } from 'fastify';
import { logger } from '../audit/logger.js';
import { DaytonaApiBrowserProvider, type DaytonaApiBrowserProviderOptions, type DaytonaViewerGrantPort } from '../tools/browser-daytona/client.js';
import { createConfiguredDaytonaRoleLifecycle } from '../tools/browser-daytona/lifecycle.js';
import { DaytonaBrowserError, type DaytonaBinding, type DaytonaBrowserStore, type DaytonaProvider } from '../tools/browser-daytona/contract.js';
import { DaytonaBrowserService } from '../tools/browser-daytona/service.js';
import { assertDaytonaBinding, assertDaytonaMission, DynamoDaytonaBrowserStore } from '../tools/browser-daytona/store.js';
import { EncryptedDaytonaViewerGrantPort } from '../tools/browser-daytona/viewer-grants.js';
import { DynamoDaytonaViewerGrantStore, type DaytonaViewerGrantStore } from '../tools/browser-daytona/viewer-grant-store.js';
import { DaytonaViewerExpiryController, type DaytonaViewerExpiryResult } from '../tools/browser-daytona/viewer-expiry.js';
import type { DaytonaGatewayAdapter, DaytonaGatewayRuntime } from '../tools/browser-cloud-gateway/index.js';
import { DaytonaViewerHandoffService, DynamoDaytonaViewerTicketStore, type DaytonaViewerMissionBoundary, type DaytonaViewerTicketStore } from './daytona-viewer-service.js';
import { registerDaytonaViewerRoutes, type DaytonaViewerOptions, type DaytonaViewerService } from './daytona-viewer.js';
import { createConfiguredDaytonaArtifactPorts } from './daytona-artifact-ports.js';
import { agentDesktopTemplates, companyEnrollmentTemplate, companyTemplateForRole, DaytonaCompanyEnrollment } from './daytona-company-enrollment.js';

type CapableProvider = DaytonaProvider & { capabilities: Readonly<{ checkpoint: boolean }> };
export interface DaytonaRuntimeDependencies {
  env?: NodeJS.ProcessEnv;
  /** Trusted boot/test composition only. Never supplied by a tool/route caller. */
  resolveApiToken?: () => Promise<string>;
  lifecycle?: {
    withReady<T>(binding: DaytonaBinding, run: () => Promise<T>, options?: { maxSeconds?: number }): Promise<T>;
    tick(): Promise<void>;
    shutdown(): void;
    touch(binding: DaytonaBinding): Promise<void>;
  };
  viewer?: () => DaytonaViewerGrantPort | undefined;
  createProvider?: (options: DaytonaApiBrowserProviderOptions) => CapableProvider;
  createStore?: () => DaytonaBrowserStore;
  createTickets?: () => DaytonaViewerTicketStore;
  createGrantStore?: () => DaytonaViewerGrantStore;
  scheduleTick?: (tick: () => void, milliseconds: 1000) => () => void;
  onWatchdogStatus?: (result: DaytonaViewerExpiryResult, sandboxId: string) => void;
}
export interface DaytonaRuntimeController {
  adapter: DaytonaGatewayAdapter;
  status(): { optedIn: boolean; configured: boolean; watchdogReady: boolean; missing: string[]; enrollmentConfigured: boolean; enrollmentMissing: string[] };
  initialize(): Promise<boolean>;
  shutdown(): void;
  registerRoutes(app: FastifyInstance): Promise<boolean>;
}
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
function fail(code: string): never { throw new DaytonaBrowserError(code); }

/** Construction never provisions or starts timers/provider actions. Root-opted-in
 * company discovery may conditionally enroll only the current signed connection. */
export function createDaytonaRuntimeController(dependencies: DaytonaRuntimeDependencies = {}): DaytonaRuntimeController {
  const env = dependencies.env ?? process.env;
  const table = () => env.DAYTONA_BROWSER_DDB_TABLE ?? env.CLOUD_BROWSER_DDB_TABLE;
  const grantTable = () => env.DAYTONA_VIEWER_GRANT_DDB_TABLE ?? table();
  const region = () => env.AWS_REGION ?? 'us-east-1';
  const sandboxIds = (): readonly string[] => {
    const legacy = env.DAYTONA_BROWSER_SANDBOX_ID;
    let dedicated: ReturnType<typeof agentDesktopTemplates>;
    // Broken new enrollment must never erase existing revocation workers.
    try { dedicated = agentDesktopTemplates(env); } catch { dedicated = undefined; }
    const mapped = dedicated ? Object.values(dedicated.agents).map(value => value.sandboxId) : [];
    if (env.DAYTONA_BROWSER_SANDBOX_IDS === undefined) {
      if (legacy === undefined && mapped.length) return mapped;
      if (!UUID.test(legacy ?? '')) return fail('daytona_sandbox_enrollment_invalid'); return [...new Set([legacy!, ...mapped])];
    }
    let values: unknown;
    try { values = JSON.parse(env.DAYTONA_BROWSER_SANDBOX_IDS); } catch { return fail('daytona_sandbox_enrollment_invalid'); }
    if (!Array.isArray(values) || values.length < 1 || values.length > 3 || !values.every(value => typeof value === 'string' && UUID.test(value))
      || new Set(values).size !== values.length || (legacy !== undefined && legacy !== values[0])) return fail('daytona_sandbox_enrollment_invalid');
    return [...new Set([...(values as string[]), ...mapped])];
  };
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
  const enrollmentMissing = (): string[] => {
    if (env.DAYTONA_AGENT_DESKTOP_TEMPLATES !== undefined) {
      try { agentDesktopTemplates(env); } catch { return ['DAYTONA_AGENT_DESKTOP_TEMPLATES']; }
      if (lifecycleConfigurationInvalid) return ['DAYTONA_AGENT_DESKTOP_TEMPLATES/LIFECYCLE'];
    }
    if (env.DAYTONA_COMPANY_ENROLLMENT_ENABLED === undefined || env.DAYTONA_COMPANY_ENROLLMENT_ENABLED === 'false') return [];
    try { companyEnrollmentTemplate(env, sandboxIds()); return []; }
    catch { return [env.DAYTONA_AGENT_DESKTOP_TEMPLATES !== undefined ? 'DAYTONA_AGENT_DESKTOP_TEMPLATES' : 'DAYTONA_COMPANY_ENROLLMENT_ENABLED/SANDBOX_ID/READINESS_SHA256']; }
  };
  let roleLifecycle = dependencies.lifecycle;
  let lifecycleInitialized = Boolean(roleLifecycle);
  let lifecycleConfigurationInvalid = false;
  const viewerOptions = (): DaytonaViewerOptions => {
    const previewDomain = env.DAYTONA_BROWSER_PREVIEW_DOMAIN ?? '', previewPort = Number(env.DAYTONA_BROWSER_PREVIEW_PORT), viewerPath = env.DAYTONA_BROWSER_PREVIEW_PATH ?? '';
    if (!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(previewDomain) || !Number.isInteger(previewPort) || previewPort < 1 || previewPort > 65535
      || !/^\/[A-Za-z0-9_./-]+$/.test(viewerPath) || viewerPath.includes('..')) return fail('daytona_viewer_configuration_missing'); return { previewDomain, previewPort, viewerPath };
  };
  const humanMissing = (): string[] => {
    const missing: string[] = [];
    try { sandboxIds(); } catch { missing.push(env.DAYTONA_BROWSER_SANDBOX_IDS === undefined ? 'DAYTONA_BROWSER_SANDBOX_ID' : 'DAYTONA_BROWSER_SANDBOX_IDS'); }
    if (!/^[A-Za-z0-9_.-]{3,255}$/.test(grantTable() ?? '')) missing.push('DAYTONA_VIEWER_GRANT_DDB_TABLE');
    if (!/^[a-f0-9]{64}$/.test(env.DAYTONA_BROWSER_VIEWER_CONTROL_SHA256 ?? '')) missing.push('DAYTONA_BROWSER_VIEWER_CONTROL_SHA256');
    try { grantKey().fill(0); } catch { missing.push('DAYTONA_VIEWER_GRANT_KEY_BASE64'); }
    try { viewerOptions(); } catch { missing.push('DAYTONA_BROWSER_PREVIEW_DOMAIN/PORT/PATH'); } return missing;
  };
  let ownedStore: DaytonaBrowserStore | undefined;
  const sessionStore = () => ownedStore ??= dependencies.createStore?.() ?? new DynamoDaytonaBrowserStore({ tableName: table(), region: region() });
  const expiries = new Map<string, DaytonaViewerExpiryController>(), cancelTicks: (() => void)[] = [], lastAttention = new Map<string, string>();
  let initializing: Promise<boolean> | undefined;
  let running = false, closed = false;
  const workerReady = (id: string) => !closed && running && expiries.get(id)?.ready() === true;
  const expiryReady = () => expiries.size > 0 && [...expiries.keys()].every(workerReady);
  const anyExpiryReady = () => [...expiries.keys()].some(workerReady);
  const status = () => {
    // Optional discovery enrollment cannot disable existing viewer revocation
    // routes or their expiry watchdog after a restart. Report it separately.
    const missing = [...commonMissing(), ...humanMissing()]; if (env.DAYTONA_BROWSER_ENABLED !== 'true') missing.unshift('DAYTONA_BROWSER_ENABLED');
    const enrollmentProblems = enrollmentMissing();
    return { optedIn: env.DAYTONA_BROWSER_ENABLED === 'true', configured: missing.length === 0, watchdogReady: expiryReady(), missing,
      enrollmentConfigured: missing.length === 0 && env.DAYTONA_COMPANY_ENROLLMENT_ENABLED === 'true' && enrollmentProblems.length === 0, enrollmentMissing: enrollmentProblems };
  };
  const requireExpiry = (sandboxId?: string) => {
    if (!status().configured || !(sandboxId === undefined ? anyExpiryReady() : sandboxIds().includes(sandboxId) && workerReady(sandboxId))) fail('daytona_viewer_expiry_unavailable');
  };
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
      for (const sandboxId of sandboxIds()) expiries.set(sandboxId, new DaytonaViewerExpiryController({ store, port: viewer, organizationId: env.DAYTONA_BROWSER_ORGANIZATION_ID!, sandboxId }));
    }
    const provider = (dependencies.createProvider ?? (options => new DaytonaApiBrowserProvider(options)))({ apiBaseUrl: env.DAYTONA_BROWSER_API_BASE_URL!, organizationId: env.DAYTONA_BROWSER_ORGANIZATION_ID!, resolveApiToken, toolboxAllowedOrigins: origins(), ...createConfiguredDaytonaArtifactPorts({ env }), ...(viewer ? { viewer } : {}) });
    const store = sessionStore(), service = new DaytonaBrowserService(store, provider);
    if (!lifecycleInitialized) {
      lifecycleInitialized = true;
      try { roleLifecycle = createConfiguredDaytonaRoleLifecycle({ env, resolveApiToken }); }
      catch { roleLifecycle = undefined; lifecycleConfigurationInvalid = true; /* invalid new setup cannot destroy sealed cleanup */ }
    }
    // Opt-out or broken enrollment configuration cannot break sealed cleanup.
    const template = status().enrollmentConfigured ? companyEnrollmentTemplate(env, sandboxIds()) : undefined;
    const withReady = <T>(binding: DaytonaBinding, run: () => Promise<T>, maxSeconds = 180): Promise<T> => {
      if (env.DAYTONA_AGENT_DESKTOP_TEMPLATES === undefined) return run();
      if (!roleLifecycle) return fail('daytona_role_configuration_invalid');
      return roleLifecycle.withReady(binding, run, { maxSeconds });
    };
    const enrollment = new DaytonaCompanyEnrollment(template, store, provider, requireExpiry, withReady);
    const approved = async (caller: string, profile: string, principal?: string) => {
      const binding = await store.loadBinding(profile); assertDaytonaBinding(binding);
      if (binding.profileKey !== profile || binding.owner !== caller || binding.ownerSubjectHash !== principal || !sandboxIds().includes(binding.sandboxId)) fail('owner_forbidden');
      if (env.DAYTONA_AGENT_DESKTOP_TEMPLATES !== undefined) {
        const dedicated = agentDesktopTemplates(env)!;
        const expected = companyTemplateForRole(dedicated, caller);
        if (binding.sharedProfileKey !== 'company-browser' || binding.sandboxId !== expected.sandboxId || binding.readinessReceiptSha256 !== expected.readinessReceiptSha256) fail('owner_forbidden');
      }
      requireExpiry(binding.sandboxId); return binding;
    };
    const approvedSession = async (caller: string, id: string, principal?: string) => {
      const session = await store.loadSession(id); assertDaytonaMission(session);
      if (session.sessionId !== id || session.owner !== caller || session.ownerSubjectHash !== principal) fail('owner_forbidden');
      const binding = await approved(caller, session.profileKey, principal);
      if (session.sandboxId !== binding.sandboxId) fail('owner_forbidden'); return session;
    };
    const browser: DaytonaGatewayRuntime['browser'] = {
      discover: async (caller, principal, profile) => { await enrollment.ensure(caller, principal, profile); const result = await service.discover(caller, principal, profile); await approved(caller, result.profileId, principal); return result; },
      ...(env.DAYTONA_AGENT_DESKTOP_TEMPLATES === undefined || !template ? {} : { startCompany: async (caller: string, seconds: number, budget: number | undefined, principal: string) => {
        if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 28800) fail('invalid_duration');
        if (budget !== undefined && (!Number.isSafeInteger(budget) || budget < 1 || budget > 10000)) fail('invalid_action_budget');
        if (!template || !roleLifecycle) fail('daytona_role_configuration_invalid');
        return enrollment.withEnrolledBinding(caller, principal, seconds, async binding => {
          await approved(caller, binding.profileKey, principal);
          return service.start(caller, binding.profileKey, seconds, budget, principal, { requireMultiMission: true });
        });
      } }),
      readiness: async (caller, profile, principal) => { const binding = await approved(caller, profile, principal); return withReady(binding, async () => { await approved(caller, profile, principal); return service.readiness(caller, profile, principal); }); },
      start: async (caller, profile, seconds, budget, principal, options) => {
        if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 28800) fail('invalid_duration');
        if (budget !== undefined && (!Number.isSafeInteger(budget) || budget < 1 || budget > 10000)) fail('invalid_action_budget');
        const binding = await approved(caller, profile, principal); return withReady(binding, async () => { await approved(caller, profile, principal); return service.start(caller, profile, seconds, budget, principal, options); }, seconds);
      },
      execute: async (caller, id, action, seconds, principal) => { await approvedSession(caller, id, principal); return service.execute(caller, id, action, seconds, principal); },
      snapshot: async (caller, id, principal) => { await approvedSession(caller, id, principal); return service.snapshot(caller, id, principal); },
      savePersistentProfile: async (caller, id, principal) => { await approvedSession(caller, id, principal); return service.savePersistentProfile(caller, id, principal); },
      stop: async (caller, id, principal) => {
        const previous = roleLifecycle && env.DAYTONA_AGENT_DESKTOP_TEMPLATES !== undefined ? await store.loadSession(id) : null;
        await service.stop(caller, id, principal);
        if (previous && previous.phase !== 'CLOSED' && roleLifecycle) {
          assertDaytonaMission(previous);
          if (previous.sessionId !== id || previous.owner !== caller || previous.ownerSubjectHash !== principal) return fail('owner_forbidden');
          const binding = await store.loadBinding(previous.profileKey); assertDaytonaBinding(binding);
          if (binding.owner === caller && binding.ownerSubjectHash === principal && binding.sandboxId === previous.sandboxId) await roleLifecycle.touch(binding);
        }
      },
    };
    const grantPreflight = async (caller: string, id: string, principal: string) => {
      const session = await approvedSession(caller, id, principal);
      const readiness = await browser.readiness(caller, session.profileKey, principal); if (readiness.checkpointReady !== true) fail('daytona_checkpoint_unavailable');
    };
    const tickets = dependencies.createTickets?.() ?? new DynamoDaytonaViewerTicketStore({ tableName: table(), region: region() });
    const missions: DaytonaViewerMissionBoundary = {
      loadSession: id => store.loadSession(id),
      getViewerGrant: async (caller, id, principal, seconds, notAfter) => { await grantPreflight(caller, id, principal); return service.getViewerGrant(caller, id, principal, seconds, notAfter); },
      resumeViewerGrant: async (caller, id, principal, handle) => { await approvedSession(caller, id, principal); return service.resumeViewerGrant(caller, id, principal, handle); }, completeHumanInput: service.completeHumanInput.bind(service), stop: browser.stop,
    };
    // Admission must reject an unhealthy target inside owned(), BEFORE the
    // ticket CAS. Another healthy worker cannot strand this ticket in ISSUING
    // or RESUMING on an otherwise proven no-provider-effect refusal.
    const handoff = new DaytonaViewerHandoffService(tickets, { ...missions, loadSession: async id => {
      const session = await store.loadSession(id); if (session === null) return null; assertDaytonaMission(session);
      if (session.sessionId !== id) fail('owner_forbidden');
      const binding = await approved(session.owner, session.profileKey, session.ownerSubjectHash);
      if (binding.sandboxId !== session.sandboxId) fail('owner_forbidden'); return session;
    } });
    const cleanup = new DaytonaViewerHandoffService(tickets, missions);
    const viewers = { issue: async (...args: Parameters<DaytonaViewerHandoffService['issue']>) => { await approvedSession(args[0], args[1], args[2]); return handoff.issue(...args); },
      exchange: async (token: string) => { requireExpiry(); return handoff.exchange(token); }, resume: async (token: string) => { requireExpiry(); return handoff.resume(token); },
      // Cleanup remains possible after scheduler/config degradation. Health is
      // NOT a human-input-revoked receipt; the core still owns all mission fences.
      complete: cleanup.complete.bind(cleanup), expire: cleanup.expire.bind(cleanup) };
    return instance = { browser, viewers, capabilities: Object.freeze({ checkpoint: provider.capabilities.checkpoint === true, humanViewer: Boolean(viewer) }) };
  };
  const runTick = async (sandboxId: string, expiry: DaytonaViewerExpiryController) => {
    if (!running) return;
    const result = await expiry.tick(); dependencies.onWatchdogStatus?.(result, sandboxId);
    const attention = result.status === 'operator_attention' ? result.reason : '';
    if (attention && attention !== lastAttention.get(sandboxId)) logger.warn({ type: 'daytona_viewer_expiry', status: 'operator_attention', reason: attention, sandboxId }, 'Daytona viewer expiry requires owned operator reconciliation');
    lastAttention.set(sandboxId, attention);
  };
  const initialize = async (): Promise<boolean> => {
    if (closed || !status().configured) return false; if (running && !initializing) return expiryReady(); if (initializing) return initializing;
    initializing = (async () => {
      build(); running = true; await Promise.all([...expiries].map(([id, expiry]) => runTick(id, expiry)));
      if (roleLifecycle) await roleLifecycle.tick().catch(() => undefined);
      if (!closed) {
        for (const [id, expiry] of expiries) {
          const callback = () => { void runTick(id, expiry).catch(() => undefined); };
          cancelTicks.push(dependencies.scheduleTick?.(callback, 1000) ?? (() => { const timer = setInterval(callback, 1000); timer.unref(); return () => clearInterval(timer); })());
        }
        if (roleLifecycle) {
          const callback = () => { if (running) void roleLifecycle!.tick().catch(() => undefined); };
          cancelTicks.push(dependencies.scheduleTick?.(callback, 1000) ?? (() => { const timer = setInterval(callback, 1000); timer.unref(); return () => clearInterval(timer); })());
        }
      }
      return expiryReady();
    })();
    try { return await initializing; }
    catch { running = false; for (const cancel of cancelTicks.splice(0)) cancel(); return false; }
    finally { initializing = undefined; }
  };
  const shutdown = () => { if (closed) return; closed = true; running = false; for (const cancel of cancelTicks.splice(0)) cancel(); roleLifecycle?.shutdown(); };
  const adapter: DaytonaGatewayAdapter = {
    get: async () => status().configured && anyExpiryReady() ? build() : undefined,
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
