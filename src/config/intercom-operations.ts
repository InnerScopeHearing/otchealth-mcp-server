/** Compact documented Intercom/Fin control plane; execution gates live in each handler. */
export const INTERCOM_OPERATIONS_TOOLSET = [
  'intercom_operation_catalog', 'intercom_operation_schema',
  'intercom_operation_read', 'intercom_operation_write',
  'intercom_fin_operation_catalog', 'intercom_fin_operation_schema',
  'intercom_fin_operation_invoke',
] as const;

export function isIntercomOperationsLane(lane: string): boolean {
  return lane === 'cto' || lane === 'coo';
}
