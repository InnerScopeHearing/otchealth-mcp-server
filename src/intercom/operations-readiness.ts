import { createIntercomOperationsClient, IntercomOperationError, type OperationResult } from './operations-client.js';
import type { OperationInput } from './operations-contract.js';

export const INTERCOM_READINESS_OPERATIONS = [
  'identifyAdmin', 'listDataConnectors', 'listContentImportSources',
  'listOfficeHoursSchedules', 'listAudiences',
  'get__export_reporting_data_get_datasets', 'getIpAllowlist',
] as const;

/** Seven configuration-metadata GETs. No Fin invocations, customer records or setting writes. */
export async function probeIntercomOperations(options: {
  configured?: boolean;
  execute?: (input: OperationInput) => Promise<OperationResult>;
} = {}) {
  const configured = options.configured ?? Boolean(process.env.INTERCOM_ACCESS_TOKEN);
  if (!configured) return { api_version: '2.17', configured: false, ready: false, checks: [], workspace_id: null };
  const execute = options.execute ?? createIntercomOperationsClient({ timeoutMs: 2500 }).executeOperation;
  let workspaceId: string | null = null;
  const checks = await Promise.all(INTERCOM_READINESS_OPERATIONS.map(async (operation_id) => {
    try {
      const result = await execute({ operation_id, ...(operation_id === 'listDataConnectors' || operation_id === 'listAudiences' ? { query: { per_page: 1 } } : {}) });
      if (operation_id === 'identifyAdmin' && result.data && typeof result.data === 'object') {
        const app = (result.data as Record<string, unknown>).app;
        const id = app && typeof app === 'object' ? (app as Record<string, unknown>).id : null;
        if (typeof id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(id)) workspaceId = id;
      }
      return { operation_id, state: 'ready', http_status: result.status, error_code: null };
    } catch (error) {
      return {
        operation_id, state: 'blocked',
        http_status: error instanceof IntercomOperationError ? error.status : 0,
        error_code: error instanceof IntercomOperationError ? error.code : 'probe_failed',
      };
    }
  }));
  return { api_version: '2.17', configured, ready: checks.every((check) => check.state === 'ready'), checks, workspace_id: workspaceId };
}

// Cache one bounded probe batch per replica for one minute; this is an on-demand diagnostic.
let cached: { until: number; value: ReturnType<typeof probeIntercomOperations> } | undefined;
export function cachedIntercomOperationsProbe() {
  if (cached && cached.until > Date.now()) return cached.value;
  const value = probeIntercomOperations();
  cached = { until: Date.now() + 60_000, value };
  return value;
}
