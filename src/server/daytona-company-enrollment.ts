import { createHash } from 'node:crypto';
import { requestContext } from './request-context.js';
import { DaytonaBrowserError, type DaytonaBinding, type DaytonaBrowserStore, type DaytonaProvider } from '../tools/browser-daytona/contract.js';
import { assertDaytonaBinding } from '../tools/browser-daytona/store.js';

export const DAYTONA_COMPANY_ROLES = Object.freeze(['cto', 'cfo', 'clo', 'coo', 'cro', 'developer', 'wefunder-campaign-director'] as const);
const OWNERS = new Set<string>(DAYTONA_COMPANY_ROLES);
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const HASH = /^[a-f0-9]{64}$/;
const PATH = '/home/otcbrowser/.local/share/otchealth-browser/company-browser/chromium';
const fail = (code: string): never => { throw new DaytonaBrowserError(code); };
export interface DaytonaCompanyEnrollmentTemplate { sandboxId: string; readinessReceiptSha256: string }
export interface DaytonaAgentDesktopTemplates { schema: 'daytona-agent-desktops/v1'; agents: Readonly<Record<string, Readonly<DaytonaCompanyEnrollmentTemplate>>> }
export type DaytonaCompanyEnrollmentConfiguration = DaytonaCompanyEnrollmentTemplate | DaytonaAgentDesktopTemplates;

/** Exact server-owned role map. No caller fields, credentials or implicit lanes. */
export function agentDesktopTemplates(env: NodeJS.ProcessEnv): DaytonaAgentDesktopTemplates | undefined {
  if (env.DAYTONA_AGENT_DESKTOP_TEMPLATES === undefined) return undefined;
  const invalid = () => fail('daytona_agent_desktops_configuration_invalid');
  const raw = env.DAYTONA_AGENT_DESKTOP_TEMPLATES;
  if (raw.length > 8192) return invalid();
  let value: unknown; try { value = JSON.parse(raw); } catch { return invalid(); }
  const object = (item: unknown): item is Record<string, unknown> => Boolean(item && typeof item === 'object' && !Array.isArray(item));
  if (!object(value) || Object.keys(value).length !== 2 || value.schema !== 'daytona-agent-desktops/v1' || !object(value.agents)
    || Object.keys(value.agents).length !== DAYTONA_COMPANY_ROLES.length || Object.keys(value.agents).some(role => !OWNERS.has(role))) return invalid();
  const agents: Record<string, Readonly<DaytonaCompanyEnrollmentTemplate>> = {};
  for (const role of DAYTONA_COMPANY_ROLES) {
    const item = value.agents[role];
    if (!object(item) || Object.keys(item).length !== 2 || typeof item.sandboxId !== 'string' || !UUID.test(item.sandboxId) || item.sandboxId !== item.sandboxId.toLowerCase()
      || typeof item.readinessReceiptSha256 !== 'string' || !HASH.test(item.readinessReceiptSha256)) return invalid();
    agents[role] = Object.freeze({ sandboxId: item.sandboxId, readinessReceiptSha256: item.readinessReceiptSha256 });
  }
  if (new Set(Object.values(agents).map(item => item.sandboxId.toLowerCase())).size !== DAYTONA_COMPANY_ROLES.length) return invalid();
  return Object.freeze({ schema: 'daytona-agent-desktops/v1', agents: Object.freeze(agents) });
}
export function companyTemplateForRole(configuration: DaytonaCompanyEnrollmentConfiguration, role: string): Readonly<DaytonaCompanyEnrollmentTemplate> {
  if (!OWNERS.has(role)) return fail('owner_forbidden');
  return 'agents' in configuration ? configuration.agents[role]! : configuration;
}

/** Root configuration only. A receipt hash is enrollment provenance, never a
 * replacement for the fresh provider proof required below. No token collection. */
export function companyEnrollmentTemplate(env: NodeJS.ProcessEnv, allowedSandboxes: readonly string[]): DaytonaCompanyEnrollmentConfiguration | undefined {
  if (env.DAYTONA_COMPANY_ENROLLMENT_ENABLED === undefined || env.DAYTONA_COMPANY_ENROLLMENT_ENABLED === 'false') return undefined;
  if (env.DAYTONA_COMPANY_ENROLLMENT_ENABLED !== 'true') return fail('daytona_company_enrollment_configuration_invalid');
  const dedicated = agentDesktopTemplates(env);
  if (dedicated) {
    if (Object.values(dedicated.agents).some(item => !allowedSandboxes.includes(item.sandboxId))) return fail('daytona_agent_desktops_configuration_invalid');
    return dedicated;
  }
  const sandboxId = env.DAYTONA_COMPANY_ENROLLMENT_SANDBOX_ID, readinessReceiptSha256 = env.DAYTONA_COMPANY_ENROLLMENT_READINESS_SHA256;
  if (env.DAYTONA_COMPANY_ENROLLMENT_ENABLED !== 'true' || !UUID.test(sandboxId ?? '') || !allowedSandboxes.includes(sandboxId!) || !HASH.test(readinessReceiptSha256 ?? '')) return fail('daytona_company_enrollment_configuration_invalid');
  return Object.freeze({ sandboxId: sandboxId!, readinessReceiptSha256: readinessReceiptSha256! });
}

/** Internal request composition only; never an unauthenticated route/tool. Each
 * current signed OAuth authorization enrolls only itself into the approved shared
 * profile. Existing records are immutable, including across root template edits. */
export class DaytonaCompanyEnrollment {
  constructor(private readonly template: DaytonaCompanyEnrollmentConfiguration | undefined, private readonly store: DaytonaBrowserStore,
    private readonly provider: DaytonaProvider, private readonly admission: (sandboxId: string) => void | Promise<void>,
    private readonly withReady?: <T>(binding: DaytonaBinding, run: () => Promise<T>) => Promise<T>) {}
  async ensure(caller: string, principal?: string, requestedProfile?: string): Promise<void> {
    if (!this.template) return;
    const identity = () => {
      const ctx = requestContext.getStore();
      if (!OWNERS.has(caller) || ctx?.callerAgent !== caller || ctx.authKind !== 'oauth' || typeof ctx.authSubject !== 'string'
        || !ctx.authSubject.trim() || ctx.authSubject.length > 4096 || !UUID.test(ctx.authConnectionId ?? '')) return fail('oauth_connection_required');
      return createHash('sha256').update(`${caller}\0connection:${ctx.authConnectionId}`).digest('hex');
    };
    const derived = identity(), profileKey = `${caller}-${derived}`;
    if (principal !== derived || (requestedProfile !== undefined && requestedProfile !== profileKey)) return fail('owner_forbidden');
    const template = companyTemplateForRole(this.template, caller);
    const binding: DaytonaBinding = { provider: 'daytona', owner: caller, ownerSubjectHash: derived, sandboxId: template.sandboxId,
      profileKey, sharedProfileKey: 'company-browser', profilePath: PATH, readinessReceiptSha256: template.readinessReceiptSha256 };
    assertDaytonaBinding(binding);
    const exact = (existing: DaytonaBinding | null): boolean => {
      if (!existing) return false; assertDaytonaBinding(existing);
      if (Object.keys(existing).length !== Object.keys(binding).length || Object.entries(binding).some(([key, value]) => existing[key as keyof DaytonaBinding] !== value)) return fail('daytona_company_enrollment_conflict');
      return true;
    };
    const found = exact(await this.store.loadBinding(profileKey));
    await this.admission(binding.sandboxId);
    const verify = async () => {
      await this.admission(binding.sandboxId);
      const inspection = await this.provider.inspect(binding);
      if (inspection.sandboxId !== binding.sandboxId || inspection.state !== 'started' || inspection.public !== false || !this.provider.probe) return fail('daytona_not_ready');
      const proof = await this.provider.probe(binding);
      const pid = (value: unknown) => Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= 2147483647;
      if (proof?.ready !== true || proof.profileKey !== profileKey || proof.profilePath !== PATH || proof.checkpointReady !== true
        || proof.runtimeProtocol !== 2 || proof.multiMissionReady !== true || !pid(proof.browserPid) || !pid(proof.supervisorPid)) return fail('daytona_company_enrollment_not_ready');
      if (identity() !== derived) return fail('owner_forbidden');
      await this.admission(binding.sandboxId);
      if (!found) {
        // One conditional create only. A timeout is not retried here; a later
        // request may reconcile only an exact strongly-consistent record.
        await this.store.createBinding(binding);
        if (!exact(await this.store.loadBinding(profileKey))) return fail('daytona_company_enrollment_unconfirmed');
      }
    };
    if ('agents' in this.template && this.withReady) return this.withReady(binding, verify);
    return verify();
  }
}
