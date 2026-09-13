import { createHash } from 'node:crypto';
import type { MemoryRecord } from './memory.js';

export interface MemoryWriteIntent { id: string; payloadSha256: string; requestedSupersedes?: string | null }
export interface MemoryIntentInput {
  agent: string; kind: string; text: string; tags?: string[]; source?: string; supersedes?: string;
  idempotency_key?: string;
}
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
function payloadHash(input: Omit<MemoryIntentInput, 'idempotency_key'>): string {
  return digest(JSON.stringify([input.agent.trim().toLowerCase(), input.kind, input.text, input.tags ?? [], input.source ?? null, input.supersedes ?? null]));
}

/** Hash the caller's original request, before optional automatic supersession changes it. */
export function memoryWriteIntent(input: MemoryIntentInput): MemoryWriteIntent | undefined {
  if (input.idempotency_key === undefined) return undefined;
  if (!/^[A-Za-z0-9._:-]{16,128}$/.test(input.idempotency_key)) throw new Error('invalid memory idempotency key');
  const agent = input.agent.trim().toLowerCase();
  return {
    id: `m_idem_${digest(JSON.stringify([agent, input.idempotency_key]))}`,
    payloadSha256: payloadHash(input),
    requestedSupersedes: input.supersedes ?? null,
  };
}

export function validateMemoryReplay(record: MemoryRecord, agent: string, intent: MemoryWriteIntent): MemoryRecord {
  if (record.type !== 'memory' || record.agent !== agent || record.id !== intent.id ||
      record.idempotency?.payloadSha256 !== intent.payloadSha256 ||
      payloadHash({ ...record, source: record.source ?? undefined, supersedes: record.idempotency?.requestedSupersedes ?? undefined }) !== intent.payloadSha256) {
    // Never disclose the conflicting payload, key or record contents.
    throw new Error('memory idempotency conflict: use the original payload or a new operation key');
  }
  return record;
}

/** Reconcile duplicate/uncertain creates by exact readback. No blind second create. */
export async function persistMemoryOnce(
  record: MemoryRecord,
  create: (record: MemoryRecord) => Promise<void>,
  read: (id: string, agent: string) => Promise<MemoryRecord | null>,
  onReplay?: () => void,
): Promise<MemoryRecord> {
  const intent = record.idempotency && { id: record.id, payloadSha256: record.idempotency.payloadSha256 };
  if (intent) {
    const existing = await read(record.id, record.agent);
    if (existing) {
      const validated = validateMemoryReplay(existing, record.agent, intent);
      onReplay?.();
      return validated;
    }
  }
  try {
    await create(record);
    return record;
  } catch (error) {
    if (intent) {
      const existing = await read(record.id, record.agent);
      if (existing) {
        const validated = validateMemoryReplay(existing, record.agent, intent);
        onReplay?.();
        return validated;
      }
    }
    throw error;
  }
}
