export type Delivery = { id: string | null; stored: boolean; indexed: boolean };

/** A lost storage acknowledgement is unknown, never proof of a completed write. */
export async function deliverCheckpointMemory<T extends { id: string }>(
  write: () => Promise<T>, index: (record: T) => Promise<{ indexed: boolean }>,
): Promise<Delivery> {
  let record: T;
  try { record = await write(); }
  catch { return { id: null, stored: false, indexed: false }; }
  try { return { id: record.id, stored: true, indexed: (await index(record)).indexed === true }; }
  catch { return { id: record.id, stored: true, indexed: false }; }
}

export function checkpointDeliveryStatus(deliveries: Delivery[]) {
  return {
    written: deliveries.flatMap(item => item.stored && item.id ? [item.id] : []),
    indexed: deliveries.flatMap(item => item.indexed && item.id ? [item.id] : []),
    unindexed: deliveries.flatMap(item => item.stored && !item.indexed && item.id ? [item.id] : []),
    storage_unconfirmed: deliveries.filter(item => !item.stored).length,
    checkpoint: deliveries.length > 0 && deliveries.every(item => item.stored && item.indexed),
  };
}
