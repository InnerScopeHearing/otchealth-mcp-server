import { hasRevenueCatProjectCredential } from '../revenuecat/credential-resolver.js';

/** Catalog metadata only. Never subscriber, customer, financial or secret-key data. */
export const REVENUECAT_CATALOG_READ_TOOLS = [
  'revenuecat_list_projects', 'revenuecat_project_get',
  'revenuecat_app_list', 'revenuecat_app_get',
  'revenuecat_offering_list', 'revenuecat_offering_get',
  'revenuecat_product_list', 'revenuecat_product_get',
  'revenuecat_package_list', 'revenuecat_package_get',
  'revenuecat_entitlement_list', 'revenuecat_entitlement_get',
] as const;

/** Existing catalog handlers only. No delete, price, customer, grant/revoke or refund operations. */
export const DEVELOPER_REVENUECAT_CATALOG_WRITE_TOOLS = [
  'revenuecat_product_create', 'revenuecat_product_update',
  'revenuecat_offering_create', 'revenuecat_offering_update',
  'revenuecat_package_create', 'revenuecat_package_update',
  'revenuecat_entitlement_create', 'revenuecat_entitlement_update',
] as const;

const reads = new Set<string>(REVENUECAT_CATALOG_READ_TOOLS);
const writes = new Set<string>(DEVELOPER_REVENUECAT_CATALOG_WRITE_TOOLS);

/** Execution boundary, not just catalog curation. Use canonical names to cover aliases too. */
export function developerRevenueCatRejection(
  callerAgent: string | undefined,
  canonicalName: string,
  args: Record<string, unknown>,
): { code: string; message: string } | null {
  if (callerAgent !== 'developer' || !canonicalName.startsWith('revenuecat_')) return null;
  if (reads.has(canonicalName)) return null;
  if (!writes.has(canonicalName)) {
    return { code: 'revenuecat_operation_not_authorized', message: 'Developer RevenueCat access is limited to approved catalog metadata and bounded catalog configuration.' };
  }
  if (typeof args.project_id !== 'string' || !hasRevenueCatProjectCredential(args.project_id)) {
    return { code: 'revenuecat_project_not_authorized', message: 'Developer catalog configuration requires an explicitly bound project credential. Ask CTO to verify the existing project binding.' };
  }
  return null;
}
