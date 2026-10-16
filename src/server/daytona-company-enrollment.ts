import { createHash } from 'node:crypto';
import { requestContext } from './request-context.js';
import { DaytonaBrowserError, type DaytonaBinding, type DaytonaBrowserStore, type DaytonaProvider } from '../tools/browser-daytona/contract.js';
import { assertDaytonaBinding } from '../tools/browser-daytona/store.js';

const OWNERS = new Set(['cto', 'cfo', 'clo', 'coo', 'cro', 'developer', 'wefunder-campaign-director']);
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const HASH = /^[a-f0-9]{64}$/;
const PATH = '/home/otcbrowser/.local/share/otchealth-browser/company-browser/chromium';
const fail = (code: string): never => { throw new DaytonaBrowserError(code); };
export interface DaytonaCompanyEnrollmentTemplate { sandboxId: string; readinessReceiptSha256: string }

/** Root configuration only. A receipt hash is enrollment provenance, never a
 * replacement for the fresh provider proof required below. No token collection. */
export function companyEnrollmentTemplate(env: NodeJS.ProcessEnv, allowedSandboxes: readonly string[]): DaytonaCompanyEnrollmentTemplate | undefined {
  if (env.DAYTONA_COMPANY_ENROLLMENT_ENABLED === undefined || env.DAYTONA_COMPANY_ENROLLMENT_ENABLED === 'false') return undefined;
  const sandboxId = env.DAYTONA_COMPANY_ENROLLMENT_SANDBOX_ID, readinessReceiptSha256 = env.DAYTONA_COMPANY_ENROLLMENT_READINESS_SHA256;
  if (env.DAYTONA_COMPANY_ENROLLMENT_ENABLED !== 'true' || !UUID.test(sandboxId ?? '') || !allowedSandboxes.includes(sandboxId!) || !HASH.test(readinessReceiptSha256 ?? '')) return fail('daytona_company_enrollment_configuration_invalid');
  return Object.freeze({ sandboxId: sandboxId!, readinessReceiptSha256: readinessReceiptSha256! });
}

/** Internal request composition only; never an unauthenticated route/tool. Each
 * current signed OAuth authorization enrolls only itself into the approved shared
 * profile. Existing records are immutable, including across root template edits. */
export class DaytonaCompanyEnrollment {
  constructor(private readonly template: DaytonaCompanyEnrollmentTemplate | undefined, private readonly store: DaytonaBrowserStore,
    private readonly provider: DaytonaProvider, private readonly admission: (sandboxId: string) => void | Promise<void>) {}
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
    const binding: DaytonaBinding = { provider: 'daytona', owner: caller, ownerSubjectHash: derived, sandboxId: this.template.sandboxId,
      profileKey, sharedProfileKey: 'company-browser', profilePath: PATH, readinessReceiptSha256: this.template.readinessReceiptSha256 };
    assertDaytonaBinding(binding);
    const exact = (existing: DaytonaBinding | null): boolean => {
      if (!existing) return false; assertDaytonaBinding(existing);
      if (Object.keys(existing).length !== Object.keys(binding).length || Object.entries(binding).some(([key, value]) => existing[key as keyof DaytonaBinding] !== value)) return fail('daytona_company_enrollment_conflict');
      return true;
    };
    const found = exact(await this.store.loadBinding(profileKey));
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
  }
}
