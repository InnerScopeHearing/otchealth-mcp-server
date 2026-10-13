import { createHash } from 'node:crypto';

export type BrowserPrintJobStatus = 'intent' | 'effect_unknown' | 'accepted';
export type BrowserPrinterDeviceStatus = 'accepted' | 'queued' | 'printing' | 'completed' | 'failed';

export interface BrowserPrinterBinding {
  owner: string;
  printerId: string;
  authenticatedBridgeId: string;
  enabled: boolean;
}

export interface BrowserPrintDocument {
  owner: string;
  fileId: string;
  immutable: boolean;
  complete: boolean;
  scannedClean: boolean;
  mimeType: string;
  sha256: string;
  hashVerified: boolean;
  pageCount: number;
  pageCountVerified: boolean;
}

export interface BrowserPrintJob {
  /** Stable broker job identifier, also used to read back an uncertain operation. */
  jobId: string;
  owner: string;
  idempotencyKey: string;
  argsDigest: string;
  printerId: string;
  fileId: string;
  documentSha256: string;
  copies: number;
  status: BrowserPrintJobStatus;
  fence: string;
  deviceJobId?: string;
}

export type BrowserPrintClaim =
  | { kind: 'claimed'; job: BrowserPrintJob; fence: string }
  | { kind: 'existing'; job: BrowserPrintJob }
  | { kind: 'conflict' };

/** Store implementations must make claim atomic per (owner, idempotencyKey),
 * and honor the current fence on every state transition. */
export interface BrowserPrinterStore {
  getBinding(owner: string, printerId: string): Promise<BrowserPrinterBinding | null>;
}

/** Only complete immutable file records with scanner and PDF metadata are eligible. */
export interface BrowserPrintDocumentStore {
  getDocument(owner: string, fileId: string): Promise<BrowserPrintDocument | null>;
}

export interface BrowserPrintJobStore {
  claim(input: {
    owner: string;
    idempotencyKey: string;
    argsDigest: string;
    printerId: string;
    fileId: string;
    documentSha256: string;
    copies: number;
  }): Promise<BrowserPrintClaim>;
  markEffectUnknown(input: { owner: string; jobId: string; fence: string }): Promise<boolean>;
  markAccepted(input: { owner: string; jobId: string; fence: string; deviceJobId: string }): Promise<boolean>;
  get(owner: string, jobId: string): Promise<BrowserPrintJob | null>;
}

export interface BrowserPrinterReceipt {
  authenticatedBridgeId: string;
  printerId: string;
  deviceJobId: string;
  deviceStatus: BrowserPrinterDeviceStatus;
}

export interface BrowserPrinterBridge {
  /** The bridge resolves and authenticates this registered binding itself. */
  submit(input: {
    /** Stable correlation/idempotency reference; bridge retains it before device submission. */
    brokerJobId: string;
    binding: BrowserPrinterBinding;
    document: { fileId: string; sha256: string };
    copies: number;
  }): Promise<BrowserPrinterReceipt>;
  /** Optional authenticated device readback. `completed` is device-reported and
   * does not prove that paper was physically output. */
  getReceipt?(input: { binding: BrowserPrinterBinding; deviceJobId: string }): Promise<BrowserPrinterReceipt | null>;
}

export interface BrowserPrintResult {
  jobId: string;
  status: 'accepted' | 'needs_reconciliation';
  printerId: string;
  documentSha256: string;
  copies: number;
}

export class BrowserPrintError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'BrowserPrintError'; }
}

const opaqueId = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const digestPattern = /^[a-f0-9]{64}$/;
const keyPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;

function fail(code: string, message: string): never { throw new BrowserPrintError(code, message); }

function validate(owner: string, input: { printerId: string; fileId: string; copies: number; idempotencyKey: string }): void {
  if (!opaqueId.test(owner)) fail('INVALID_OWNER', 'Owner reference is invalid');
  if (!opaqueId.test(input.printerId)) fail('INVALID_PRINTER', 'Printer reference is invalid');
  if (!opaqueId.test(input.fileId)) fail('INVALID_DOCUMENT', 'Document reference is invalid');
  if (!Number.isInteger(input.copies) || input.copies < 1 || input.copies > 5) fail('INVALID_COPIES', 'Copies must be an integer from 1 to 5');
  if (!keyPattern.test(input.idempotencyKey)) fail('INVALID_IDEMPOTENCY_KEY', 'Idempotency key is invalid');
}

function argsDigest(input: { printerId: string; fileId: string; documentSha256: string; copies: number }): string {
  return createHash('sha256').update(JSON.stringify([input.printerId, input.fileId, input.documentSha256, input.copies])).digest('hex');
}

function validateBinding(binding: BrowserPrinterBinding | null, owner: string, printerId: string): BrowserPrinterBinding {
  if (!binding || binding.owner !== owner || binding.printerId !== printerId || !opaqueId.test(binding.authenticatedBridgeId) || binding.enabled !== true) {
    fail('PRINTER_UNAVAILABLE', 'An enabled owner-bound authenticated printer binding is required');
  }
  return binding;
}

function validateDocument(document: BrowserPrintDocument | null, owner: string, fileId: string): BrowserPrintDocument {
  if (!document || document.owner !== owner || document.fileId !== fileId || !opaqueId.test(document.fileId)
    || document.immutable !== true || document.complete !== true || document.scannedClean !== true
    || document.mimeType !== 'application/pdf' || !digestPattern.test(document.sha256) || document.hashVerified !== true
    || !Number.isInteger(document.pageCount) || document.pageCount < 1 || document.pageCount > 100 || document.pageCountVerified !== true) {
    fail('DOCUMENT_UNAVAILABLE', 'A complete, scanned, owner-bound PDF document is required');
  }
  return document;
}

function acceptedReceipt(receipt: BrowserPrinterReceipt, binding: BrowserPrinterBinding): boolean {
  return receipt.authenticatedBridgeId === binding.authenticatedBridgeId
    && receipt.printerId === binding.printerId
    && opaqueId.test(receipt.deviceJobId)
    && receipt.deviceStatus === 'accepted';
}

export class BrowserPrintBroker {
  constructor(private readonly ports: {
    printers: BrowserPrinterStore;
    documents: BrowserPrintDocumentStore;
    bridge: BrowserPrinterBridge;
    jobs: BrowserPrintJobStore;
  }) {}

  async print(owner: string, input: { printerId: string; fileId: string; copies: number; idempotencyKey: string }): Promise<BrowserPrintResult> {
    validate(owner, input);
    const binding = validateBinding(await this.ports.printers.getBinding(owner, input.printerId), owner, input.printerId);
    const document = validateDocument(await this.ports.documents.getDocument(owner, input.fileId), owner, input.fileId);
    if (document.pageCount * input.copies > 100) fail('PRINT_LIMIT_EXCEEDED', 'The requested print exceeds 100 total pages');

    const digest = argsDigest({ ...input, documentSha256: document.sha256 });
    const claim = await this.ports.jobs.claim({
      owner, idempotencyKey: input.idempotencyKey, argsDigest: digest,
      printerId: input.printerId, fileId: input.fileId, documentSha256: document.sha256, copies: input.copies,
    });
    if (claim.kind === 'conflict') fail('IDEMPOTENCY_CONFLICT', 'Idempotency key was already used for different print arguments');
    const resolvedJob = claim.job;
    if (!resolvedJob || resolvedJob.owner !== owner || resolvedJob.idempotencyKey !== input.idempotencyKey
      || !opaqueId.test(resolvedJob.jobId) || resolvedJob.printerId !== input.printerId || resolvedJob.fileId !== input.fileId
      || resolvedJob.documentSha256 !== document.sha256 || resolvedJob.copies !== input.copies) {
      fail('JOB_STORE_CONFLICT', 'Print intent could not be claimed safely');
    }
    if (claim.kind === 'existing') {
      if (claim.job.argsDigest !== digest) fail('IDEMPOTENCY_CONFLICT', 'Idempotency key was already used for different print arguments');
      return {
        jobId: claim.job.jobId,
        status: claim.job.status === 'accepted' ? 'accepted' : 'needs_reconciliation',
        printerId: claim.job.printerId,
        documentSha256: claim.job.documentSha256,
        copies: claim.job.copies,
      };
    }

    const { job, fence } = claim;
    if (job.argsDigest !== digest || job.owner !== owner || job.idempotencyKey !== input.idempotencyKey || job.fence !== fence) {
      fail('JOB_STORE_CONFLICT', 'Print intent could not be claimed safely');
    }
    // Persist uncertainty before crossing the physical-device effect boundary.
    if (!await this.ports.jobs.markEffectUnknown({ owner, jobId: job.jobId, fence })) {
      fail('JOB_FENCE_LOST', 'Print intent lost its durable claim before submission');
    }

    try {
      const receipt = await this.ports.bridge.submit({
        brokerJobId: job.jobId,
        binding,
        document: { fileId: document.fileId, sha256: document.sha256 },
        copies: input.copies,
      });
      if (!acceptedReceipt(receipt, binding)) return this.result(job, 'needs_reconciliation');
      if (!await this.ports.jobs.markAccepted({ owner, jobId: job.jobId, fence, deviceJobId: receipt.deviceJobId })) {
        return this.result(job, 'needs_reconciliation');
      }
      return this.result(job, 'accepted');
    } catch {
      // The bridge may have accepted the job before its acknowledgment was lost.
      return this.result(job, 'needs_reconciliation');
    }
  }

  /** Read authenticated device status for an accepted broker job when the bridge supports it. */
  async getDeviceReceipt(owner: string, jobId: string): Promise<BrowserPrinterReceipt | null> {
    if (!opaqueId.test(owner) || !opaqueId.test(jobId)) fail('INVALID_REFERENCE', 'Print job reference is invalid');
    if (!this.ports.bridge.getReceipt) return null;
    const job = await this.ports.jobs.get(owner, jobId);
    if (!job || job.owner !== owner || job.status !== 'accepted' || !job.deviceJobId) return null;
    const binding = validateBinding(await this.ports.printers.getBinding(owner, job.printerId), owner, job.printerId);
    const receipt = await this.ports.bridge.getReceipt({ binding, deviceJobId: job.deviceJobId });
    if (!receipt || receipt.authenticatedBridgeId !== binding.authenticatedBridgeId
      || receipt.printerId !== binding.printerId || receipt.deviceJobId !== job.deviceJobId) return null;
    return receipt;
  }

  private result(job: BrowserPrintJob, status: BrowserPrintResult['status']): BrowserPrintResult {
    return { jobId: job.jobId, status, printerId: job.printerId, documentSha256: job.documentSha256, copies: job.copies };
  }
}
