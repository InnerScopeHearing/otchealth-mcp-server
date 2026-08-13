import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reserveHeyGenSpend, settleHeyGenSpend } from './spend-controller.js';
import type { HeyGenBrokerDeps } from './broker.js';

function harness() {
  type Row = { doc: Record<string, unknown>; etag: string };
  const store = new Map<string, Row>();
  let serial = 0;
  const deps = {
    now: () => 1_000_000,
    read: (async (_container: string, pk: string, id: string) => {
      assert.equal(pk, id);
      const row = store.get(id);
      return row ? { doc: row.doc, etag: row.etag } : null;
    }) as HeyGenBrokerDeps['read'],
    create: (async (_container: string, pk: string, doc: Record<string, unknown>) => {
      const id = String(doc.id);
      assert.equal(pk, id);
      if (store.has(id)) throw new Error('conflict');
      const etag = `E${++serial}`;
      store.set(id, { doc, etag });
      return { ok: true, status: 201, body: doc, etag };
    }) as HeyGenBrokerDeps['create'],
    replace: (async (_container: string, pk: string, id: string, doc: Record<string, unknown>, ifMatch: string) => {
      assert.equal(pk, id);
      const current = store.get(id);
      if (!current || current.etag !== ifMatch) return { ok: false, status: 412, body: null, etag: null };
      const etag = `E${++serial}`;
      store.set(id, { doc, etag });
      return { ok: true, status: 200, body: doc, etag };
    }) as HeyGenBrokerDeps['replace'],
  };
  return { deps, store };
}

const base = {
  accountId: 'account_1',
  operationId: 'operation_1',
  kind: 'avatar_video' as const,
  maxCredits: 5,
  reserveCredits: 100,
  premiumCreditsBefore: 591,
  billingStateSha256: 'a'.repeat(64),
};

test('account spend controller serializes credit-consuming operations and releases settled work', async () => {
  const h = harness();
  const first = await reserveHeyGenSpend(base, h.deps);
  const same = await reserveHeyGenSpend(base, h.deps);
  assert.equal(same.operationIdSha256, first.operationIdSha256);
  await assert.rejects(() => reserveHeyGenSpend({ ...base, operationId: 'operation_2' }, h.deps), /already holds/);
  await settleHeyGenSpend(first, 'accepted', h.deps);
  const second = await reserveHeyGenSpend({ ...base, operationId: 'operation_2' }, h.deps);
  assert.notEqual(second.operationIdSha256, first.operationIdSha256);
});

test('ambiguous spend enters reconciliation lock and reserve violations fail before writes', async () => {
  const h = harness();
  const reservation = await reserveHeyGenSpend(base, h.deps);
  await settleHeyGenSpend(reservation, 'outcome_unknown', h.deps);
  await assert.rejects(() => reserveHeyGenSpend({ ...base, operationId: 'operation_2' }, h.deps), /pending reconciliation/);

  const clean = harness();
  await assert.rejects(() => reserveHeyGenSpend({ ...base, premiumCreditsBefore: 102 }, clean.deps), /reserve floor/);
  assert.equal(clean.store.size, 0);
});
