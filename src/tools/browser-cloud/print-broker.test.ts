import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BrowserPrintBroker,
  BrowserPrintError,
  type BrowserPrintClaim,
  type BrowserPrintJob,
  type BrowserPrinterBinding,
  type BrowserPrintDocument,
  type BrowserPrinterReceipt,
} from './print-broker.js';

const binding: BrowserPrinterBinding = { owner: 'owner-1', printerId: 'printer-1', authenticatedBridgeId: 'bridge-1', enabled: true };
const document: BrowserPrintDocument = {
  owner: 'owner-1', fileId: 'file-1', immutable: true, complete: true, scannedClean: true,
  mimeType: 'application/pdf', sha256: 'a'.repeat(64), hashVerified: true, pageCount: 20, pageCountVerified: true,
};
const request = { printerId: 'printer-1', fileId: 'file-1', copies: 1, idempotencyKey: 'print-key-0001' };

function job(overrides: Partial<BrowserPrintJob> = {}): BrowserPrintJob {
  return {
    jobId: 'job-1', owner: 'owner-1', idempotencyKey: request.idempotencyKey, argsDigest: 'digest',
    printerId: request.printerId, fileId: request.fileId, documentSha256: document.sha256,
    copies: request.copies, status: 'intent', fence: 'fence-1', ...overrides,
  };
}

function harness(options: {
  printer?: BrowserPrinterBinding | null;
  document?: BrowserPrintDocument | null;
  receipt?: BrowserPrinterReceipt;
  submitError?: Error;
  claim?: BrowserPrintClaim;
  deviceReceipt?: BrowserPrinterReceipt | null;
} = {}) {
  let calls = 0;
  let stored = options.claim?.kind === 'claimed' ? options.claim.job : job();
  const bridgeInputs: unknown[] = [];
  let effectMarked = 0;
  const broker = new BrowserPrintBroker({
    printers: { getBinding: async () => options.printer === undefined ? binding : options.printer },
    documents: { getDocument: async () => options.document === undefined ? document : options.document },
    jobs: {
      claim: async ({ argsDigest }) => {
        calls += 1;
        if (options.claim) return options.claim;
        if (calls > 1) return { kind: 'existing', job: stored };
        const claimed = job({ argsDigest });
        stored = claimed;
        return { kind: 'claimed', job: claimed, fence: claimed.fence };
      },
      markEffectUnknown: async () => { effectMarked += 1; stored.status = 'effect_unknown'; return true; },
      markAccepted: async ({ deviceJobId }) => { stored.status = 'accepted'; stored.deviceJobId = deviceJobId; return true; },
      get: async () => stored,
    },
    bridge: {
      submit: async (input) => {
        bridgeInputs.push(input);
        if (options.submitError) throw options.submitError;
        return options.receipt ?? { authenticatedBridgeId: 'bridge-1', printerId: 'printer-1', deviceJobId: 'device-job-1', deviceStatus: 'accepted' };
      },
      getReceipt: options.deviceReceipt === undefined ? undefined : async () => options.deviceReceipt ?? null,
    },
  });
  return { broker, bridgeInputs, get calls() { return calls; }, get effectMarked() { return effectMarked; } };
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => error instanceof BrowserPrintError && error.code === code);
}

test('prints only a clean, immutable owner-bound PDF within copy and page bounds', async () => {
  const h = harness();
  const result = await h.broker.print('owner-1', request);
  assert.deepEqual(result, { jobId: 'job-1', status: 'accepted', printerId: 'printer-1', documentSha256: document.sha256, copies: 1 });
  assert.equal(h.effectMarked, 1);
  assert.deepEqual(h.bridgeInputs, [{ binding, document: { fileId: 'file-1', sha256: document.sha256 }, copies: 1 }]);

  await expectCode(harness().broker.print('owner-1', { ...request, copies: 0 }), 'INVALID_COPIES');
  await expectCode(harness().broker.print('owner-1', { ...request, copies: 6 }), 'INVALID_COPIES');
  await expectCode(harness({ document: { ...document, pageCount: 101 } }).broker.print('owner-1', request), 'DOCUMENT_UNAVAILABLE');
  await expectCode(harness({ document: { ...document, pageCount: 51 } }).broker.print('owner-1', { ...request, copies: 2 }), 'PRINT_LIMIT_EXCEEDED');
  await expectCode(harness({ document: { ...document, mimeType: 'text/plain' } }).broker.print('owner-1', request), 'DOCUMENT_UNAVAILABLE');
  await expectCode(harness({ document: { ...document, complete: false } }).broker.print('owner-1', request), 'DOCUMENT_UNAVAILABLE');
  await expectCode(harness({ document: { ...document, scannedClean: false } }).broker.print('owner-1', request), 'DOCUMENT_UNAVAILABLE');
  await expectCode(harness({ document: { ...document, immutable: false } }).broker.print('owner-1', request), 'DOCUMENT_UNAVAILABLE');
  await expectCode(harness({ document: { ...document, hashVerified: false } }).broker.print('owner-1', request), 'DOCUMENT_UNAVAILABLE');
  await expectCode(harness({ document: { ...document, pageCountVerified: false } }).broker.print('owner-1', request), 'DOCUMENT_UNAVAILABLE');
});

test('rejects wrong-owner and disabled or mismatched printer bindings before submit', async () => {
  const wrongOwner = harness({ document: { ...document, owner: 'owner-2' } });
  await expectCode(wrongOwner.broker.print('owner-1', request), 'DOCUMENT_UNAVAILABLE');
  assert.equal(wrongOwner.bridgeInputs.length, 0);

  for (const printer of [null, { ...binding, owner: 'owner-2' }, { ...binding, printerId: 'printer-2' }, { ...binding, enabled: false }]) {
    const h = harness({ printer });
    await expectCode(h.broker.print('owner-1', request), 'PRINTER_UNAVAILABLE');
    assert.equal(h.bridgeInputs.length, 0);
  }
});

test('validates authenticated device receipt and exposes no false physical-completion claim', async () => {
  const mismatched = harness({ receipt: { authenticatedBridgeId: 'bridge-other', printerId: 'printer-1', deviceJobId: 'device-job-1', deviceStatus: 'accepted' } });
  assert.equal((await mismatched.broker.print('owner-1', request)).status, 'needs_reconciliation');

  const h = harness({ deviceReceipt: { authenticatedBridgeId: 'bridge-1', printerId: 'printer-1', deviceJobId: 'device-job-1', deviceStatus: 'completed' } });
  const result = await h.broker.print('owner-1', request);
  assert.equal(result.status, 'accepted');
  assert.deepEqual(await h.broker.getDeviceReceipt('owner-1', 'job-1'), {
    authenticatedBridgeId: 'bridge-1', printerId: 'printer-1', deviceJobId: 'device-job-1', deviceStatus: 'completed',
  });
});

test('same-key duplicate never resubmits and different arguments conflict', async () => {
  const h = harness();
  assert.equal((await h.broker.print('owner-1', request)).status, 'accepted');
  assert.equal((await h.broker.print('owner-1', request)).status, 'accepted');
  assert.equal(h.calls, 2);
  assert.equal(h.bridgeInputs.length, 1);

  const conflict = harness({ claim: { kind: 'conflict' } });
  await expectCode(conflict.broker.print('owner-1', { ...request, copies: 2 }), 'IDEMPOTENCY_CONFLICT');
  assert.equal(conflict.bridgeInputs.length, 0);
});

test('lost acknowledgment remains unknown and a retry with the same key is never resubmitted', async () => {
  const h = harness({ submitError: new Error('private bridge detail') });
  const first = await h.broker.print('owner-1', request);
  const second = await h.broker.print('owner-1', request);
  assert.equal(first.status, 'needs_reconciliation');
  assert.equal(second.status, 'needs_reconciliation');
  assert.equal(h.bridgeInputs.length, 1);
  assert.equal(h.effectMarked, 1);
});
