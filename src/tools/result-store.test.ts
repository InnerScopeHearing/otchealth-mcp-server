import { test } from 'node:test';
import assert from 'node:assert/strict';

// Satisfy loadEnv()'s required vars (cosmos.js -> config/env.js reads at import), then import.
process.env.CIO_SITE_ID ||= 'test';
process.env.CIO_TRACK_KEY ||= 'test';
process.env.CIO_APP_API_BEARER ||= 'test';
process.env.PERPLEXITY_CONNECTOR_TOKEN ||= 'x'.repeat(32);
process.env.ADMIN_REVOKE_TOKEN ||= 'x'.repeat(32);
process.env.N8N_WEBHOOK_SECRET ||= 'x'.repeat(32);

const { buildPreview, pageCount, pageSlice, shouldOffload, extractResultSummary, PAGE_CHARS } = await import(
  './result-store.js'
);

test('extractResultSummary: Xero list envelope -> pagination + array lengths, nothing else copied', () => {
  const data = {
    body: {
      Id: 'x',
      Status: 'OK',
      pagination: { page: 1, pageSize: 100, pageCount: 18, itemCount: 1753, extra: 'ignored' },
      Invoices: new Array(100).fill({ Total: 1 }),
    },
  };
  assert.deepEqual(extractResultSummary(data), {
    pagination: { page: 1, pageSize: 100, pageCount: 18, itemCount: 1753 },
    array_lengths: { Invoices: 100 },
  });
});

test('extractResultSummary: xero_bank_transfers shim counts are carried', () => {
  const s = extractResultSummary({ total_matching: 256, page: 1, pages: 3, body: { BankTransfers: [1, 2, 3] } });
  assert.deepEqual(s, { total_matching: 256, page: 1, pages: 3, array_lengths: { BankTransfers: 3 } });
});

test('extractResultSummary: returns undefined for scalars, null and shapes with nothing recognisable', () => {
  assert.equal(extractResultSummary(null), undefined);
  assert.equal(extractResultSummary('text'), undefined);
  assert.equal(extractResultSummary({ a: 1, b: { c: 2 } }), undefined);
});

test('extractResultSummary: caps array_lengths at 8 keys', () => {
  const body: Record<string, unknown[]> = {};
  for (let i = 0; i < 12; i++) body['k' + i] = [i];
  const s = extractResultSummary({ body }) as { array_lengths: Record<string, number> };
  assert.equal(Object.keys(s.array_lengths).length, 8);
});

test('shouldOffload is false for a short result (backward-compatible: small results untouched)', () => {
  assert.equal(shouldOffload('small result'), false);
  assert.equal(shouldOffload(''), false);
});

test('buildPreview embeds the result_id, the JIT marker, and head+tail for long input', () => {
  const full = 'H'.repeat(4000) + 'M'.repeat(60000) + 'T'.repeat(1000);
  const p = buildPreview(full, 'jitres_abc');
  assert.match(p, /result_id="jitres_abc"/);
  assert.match(p, /gateway_fetch_result/);
  assert.match(p, /JIT: this result \(65000 chars\)/);
  assert.ok(p.startsWith('H'.repeat(100)), 'preview starts with the head');
  assert.ok(p.trimEnd().endsWith('T'.repeat(1000)), 'preview ends with the tail');
  assert.ok(p.length < full.length, 'preview is smaller than the full payload');
});

test('buildPreview omits the tail when input is short enough (head+marker only)', () => {
  const p = buildPreview('abc', 'jitres_x');
  assert.ok(p.startsWith('abc'));
  assert.match(p, /result_id="jitres_x"/);
});

test('pageCount: at least 1 page; splits on PAGE_CHARS boundary', () => {
  assert.equal(pageCount(0), 1);
  assert.equal(pageCount(PAGE_CHARS), 1);
  assert.equal(pageCount(PAGE_CHARS + 1), 2);
  assert.equal(pageCount(PAGE_CHARS * 3), 3);
});

test('pageSlice: clamps out-of-range pages and returns the right chunk', () => {
  const s = 'a'.repeat(PAGE_CHARS) + 'b'.repeat(PAGE_CHARS) + 'c'.repeat(500);
  const p0 = pageSlice(s, 0);
  assert.equal(p0.pages, 3);
  assert.equal(p0.page, 0);
  assert.equal(p0.chunk, 'a'.repeat(PAGE_CHARS));
  assert.equal(pageSlice(s, -5).page, 0, 'negative clamps to 0');
  const last = pageSlice(s, 99);
  assert.equal(last.page, 2, 'beyond-end clamps to last page');
  assert.equal(last.chunk, 'c'.repeat(500));
});

test('PAGE_CHARS stays below the offload threshold so a fetched page never re-offloads', () => {
  assert.ok(PAGE_CHARS < 40000);
});
