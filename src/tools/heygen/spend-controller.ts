import { createHash } from 'node:crypto';
import type { HeyGenBrokerDeps } from './broker.js';

const CACHE_CONTAINER = 'cache';
const LEASE_MS = 60 * 60_000;

type SpendState = 'idle' | 'reserved' | 'reconciling';

interface SpendDoc extends Record<string, unknown> {
  id: string;
  cacheScope: string;
  ttl: -1;
  kind: 'heygen_account_spend_controller';
  version: 1;
  state: SpendState;
  accountIdSha256: string;
  activeOperationIdSha256?: string;
  activeKind?: 'reference_look' | 'avatar_video';
  maxCredits?: number;
  reserveCredits?: number;
  billingStateSha256?: string;
  leaseExpiresAt?: string;
  updatedAt: string;
}

export interface HeyGenSpendReservation {
  id: string;
  operationIdSha256: string;
  etag: string;
}

function hash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function isSpendDoc(value: unknown): value is SpendDoc {
  if (!value || typeof value !== 'object') return false;
  const doc = value as Partial<SpendDoc>;
  return doc.kind === 'heygen_account_spend_controller' && doc.version === 1 && doc.ttl === -1 &&
    doc.cacheScope === doc.id && ['idle', 'reserved', 'reconciling'].includes(String(doc.state));
}

async function readSpend(id: string, deps: Pick<HeyGenBrokerDeps, 'read'>): Promise<{ doc: SpendDoc; etag: string } | null> {
  const row = await deps.read(CACHE_CONTAINER, id, id);
  if (!row) return null;
  if (!row.etag || !isSpendDoc(row.doc)) throw new Error('HeyGen account spend controller is invalid.');
  return { doc: row.doc, etag: row.etag };
}

export async function reserveHeyGenSpend(
  input: {
    accountId: string;
    operationId: string;
    kind: 'reference_look' | 'avatar_video';
    maxCredits: number;
    reserveCredits: number;
    premiumCreditsBefore: number;
    billingStateSha256: string;
  },
  deps: Pick<HeyGenBrokerDeps, 'read' | 'create' | 'replace' | 'now'>,
): Promise<HeyGenSpendReservation> {
  if (input.premiumCreditsBefore - input.maxCredits < input.reserveCredits) {
    throw new Error('HeyGen account spend reservation would cross the reserve floor.');
  }
  const accountHash = hash(input.accountId);
  const operationHash = hash(input.operationId);
  const id = `heygen.spend.account.${accountHash}`;
  let current = await readSpend(id, deps);
  if (!current) {
    const now = new Date(deps.now()).toISOString();
    const idle: SpendDoc = {
      id,
      cacheScope: id,
      ttl: -1,
      kind: 'heygen_account_spend_controller',
      version: 1,
      state: 'idle',
      accountIdSha256: accountHash,
      updatedAt: now,
    };
    try {
      const created = await deps.create(CACHE_CONTAINER, id, idle);
      if (!created.etag) throw new Error('missing etag');
      current = { doc: idle, etag: created.etag };
    } catch {
      current = await readSpend(id, deps);
      if (!current) throw new Error('Could not initialize HeyGen account spend controller.');
    }
  }
  if (current.doc.state === 'reserved') {
    if (current.doc.activeOperationIdSha256 === operationHash) {
      return { id, operationIdSha256: operationHash, etag: current.etag };
    }
    if (!current.doc.leaseExpiresAt || Date.parse(current.doc.leaseExpiresAt) <= deps.now()) {
      throw new Error('A stale HeyGen spend reservation requires reconciliation before new spending.');
    }
    throw new Error('Another HeyGen credit-consuming operation already holds the account spend reservation.');
  }
  if (current.doc.state === 'reconciling') {
    throw new Error('HeyGen account spending is locked pending reconciliation of an ambiguous operation.');
  }
  const next: SpendDoc = {
    ...current.doc,
    state: 'reserved',
    activeOperationIdSha256: operationHash,
    activeKind: input.kind,
    maxCredits: input.maxCredits,
    reserveCredits: input.reserveCredits,
    billingStateSha256: input.billingStateSha256,
    leaseExpiresAt: new Date(deps.now() + LEASE_MS).toISOString(),
    updatedAt: new Date(deps.now()).toISOString(),
  };
  const replaced = await deps.replace(CACHE_CONTAINER, id, id, next, current.etag);
  if (replaced.status === 412) {
    throw new Error('Another HeyGen operation won the account spend reservation.');
  }
  if (!replaced.ok || !replaced.etag) throw new Error('Could not reserve HeyGen account spending.');
  return { id, operationIdSha256: operationHash, etag: replaced.etag };
}

export async function settleHeyGenSpend(
  reservation: HeyGenSpendReservation,
  outcome: 'accepted' | 'rejected' | 'outcome_unknown',
  deps: Pick<HeyGenBrokerDeps, 'read' | 'replace' | 'now'>,
): Promise<void> {
  const current = await readSpend(reservation.id, deps);
  if (!current || current.doc.activeOperationIdSha256 !== reservation.operationIdSha256) return;
  const next: SpendDoc = outcome === 'outcome_unknown'
    ? {
        ...current.doc,
        state: 'reconciling',
        leaseExpiresAt: undefined,
        updatedAt: new Date(deps.now()).toISOString(),
      }
    : {
        ...current.doc,
        state: 'idle',
        activeOperationIdSha256: undefined,
        activeKind: undefined,
        maxCredits: undefined,
        reserveCredits: undefined,
        billingStateSha256: undefined,
        leaseExpiresAt: undefined,
        updatedAt: new Date(deps.now()).toISOString(),
      };
  const replaced = await deps.replace(CACHE_CONTAINER, next.id, next.id, next, current.etag);
  if (!replaced.ok && replaced.status !== 412) throw new Error('Could not settle HeyGen account spend reservation.');
}
