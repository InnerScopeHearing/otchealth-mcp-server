export type Delivery = { id: string | null; stored: boolean; indexed: boolean };

/** Keep the write/index sequence per record while bounding independent checkpoint fan-out. */
export const CHECKPOINT_DELIVERY_CONCURRENCY = 4;

export async function deliverCheckpointBatch<T>(
  entries: readonly T[],
  deliver: (entry: T) => Promise<Delivery>,
  concurrency = CHECKPOINT_DELIVERY_CONCURRENCY,
  hasDependencies = false,
): Promise<Delivery[]> {
  const limit = Number.isFinite(concurrency) ? Math.max(1, Math.floor(concurrency)) : 1;
  if (hasDependencies || entries.length < 2 || limit <= 1) {
    const serial: Delivery[] = [];
    for (const entry of entries) {
      try { serial.push(await deliver(entry)); }
      catch { serial.push({ id: null, stored: false, indexed: false }); }
    }
    return serial;
  }

  const results = new Array<Delivery>(entries.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (true) {
      const index = next++;
      if (index >= entries.length) return;
      try {
        results[index] = await deliver(entries[index]);
      } catch {
        // A rejected delivery has unknown storage outcome. Keep other entries moving and do not
        // invent an ID or claim success; this is the same conservative receipt as lost storage ack.
        results[index] = { id: null, stored: false, indexed: false };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(entries.length, limit) }, worker));
  return results;
}

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
