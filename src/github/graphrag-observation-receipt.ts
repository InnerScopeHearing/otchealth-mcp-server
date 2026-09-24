import { TextDecoder } from 'node:util';
import { inflateRawSync } from 'node:zlib';

export const PINNED_GRAPHRAG_OBSERVATION = Object.freeze({
  owner: 'InnerScopeHearing',
  repo: 'otchealth-cto',
  repository: 'InnerScopeHearing/otchealth-cto',
  runId: 35170671551,
  artifactId: 10476469182,
  artifactName: 'graphrag-fifth-source-provider-observation-35170671551',
  headSha: '854766e709aefcf2826cc0b5dc75c028b9b566dc',
  workflowPath: '.github/workflows/observe-managed-graphrag-company-fifth-source.yml@main',
  workflowName: 'Observe sealed company GraphRAG fifth-source ingestion',
  workflowBlobSha: '3e2f2554443fee7cb113f4f6435262cd2ec0c273',
  producerPath: 'scripts/observe_managed_graphrag_company_fifth_source.py',
  producerBlobSha: '37e4a762a50b0d239c610158ca02bc7a2f29dde8',
  knowledgeBaseId: 'XNMHPUKGDT',
  sourceId: 'LVEV3LT7LB',
  ingestionJobId: 'FBHZYSWJ9D',
  receiptSchema: 'managed-graphrag-company-fifth-source-provider-observation-v2',
  resultSchema: 'otchealth-github-managed-graphrag-observation-validation-v1',
});

export const MAX_GRAPHRAG_ARCHIVE_BYTES = 1024 * 1024;
export const MAX_GRAPHRAG_RECEIPT_BYTES = 32 * 1024;

const TERMINAL_STATUSES = new Set(['COMPLETE', 'FAILED', 'STOPPED']);
const TERMINAL_STATISTIC_KEYS = [
  'numberOfDocumentsScanned',
  'numberOfNewDocumentsIndexed',
  'numberOfModifiedDocumentsIndexed',
  'numberOfDocumentsDeleted',
  'numberOfDocumentsFailed',
] as const;
const PROGRESS_STATISTIC_KEYS = [
  'numberOfDocumentsDeleted',
  'numberOfDocumentsFailed',
  'numberOfDocumentsScanned',
  'numberOfDocumentsSkipped',
  'numberOfMetadataDocumentsModified',
  'numberOfMetadataDocumentsScanned',
  'numberOfModifiedDocumentsIndexed',
  'numberOfNewDocumentsIndexed',
] as const;

export type ObservationStatistics = Partial<Record<(typeof PROGRESS_STATISTIC_KEYS)[number], number>>;

export interface ValidatedObservationReceipt {
  receipt_schema: typeof PINNED_GRAPHRAG_OBSERVATION.receiptSchema;
  read_only: true;
  source_id: typeof PINNED_GRAPHRAG_OBSERVATION.sourceId;
  ingestion_job_id: typeof PINNED_GRAPHRAG_OBSERVATION.ingestionJobId;
  provider_status: 'COMPLETE' | 'FAILED' | 'STOPPED' | 'NONTERMINAL';
  terminal: boolean;
  terminal_statistics: ObservationStatistics | null;
  progress_statistics: ObservationStatistics | null;
  provider_updated_at_present: boolean;
}

function invalid(): never {
  throw new Error('invalid pinned observation receipt');
}

function ensureRange(buffer: Buffer, offset: number, length: number, limit = buffer.length): void {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > limit) {
    invalid();
  }
}

function readU16(buffer: Buffer, offset: number, limit = buffer.length): number {
  ensureRange(buffer, offset, 2, limit);
  return buffer.readUInt16LE(offset);
}

function readU32(buffer: Buffer, offset: number, limit = buffer.length): number {
  ensureRange(buffer, offset, 4, limit);
  return buffer.readUInt32LE(offset);
}

function validateExtraFields(buffer: Buffer, offset: number, length: number): void {
  ensureRange(buffer, offset, length);
  const end = offset + length;
  let cursor = offset;
  while (cursor < end) {
    ensureRange(buffer, cursor, 4, end);
    const fieldId = readU16(buffer, cursor, end);
    const fieldLength = readU16(buffer, cursor + 2, end);
    cursor += 4;
    ensureRange(buffer, cursor, fieldLength, end);
    // ZIP64 and alternate Unicode path/comment fields are unnecessary for this fixed ASCII member
    // and could override the interpretation made from the primary filename fields.
    if (fieldId === 0x0001 || fieldId === 0x7075 || fieldId === 0x6375) invalid();
    cursor += fieldLength;
  }
  if (cursor !== end) invalid();
}

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Read exactly one receipt.json file from a small, conventional ZIP archive without writing any
 * archive-controlled path to disk. All offsets and both compressed/decompressed sizes are checked
 * before their associated bytes are read or inflated.
 */
export function extractPinnedReceiptJson(archive: Buffer): Buffer {
  if (archive.length < 22 || archive.length > MAX_GRAPHRAG_ARCHIVE_BYTES) invalid();

  const earliestEocd = Math.max(0, archive.length - 22 - 0xffff);
  let eocdOffset = -1;
  for (let offset = archive.length - 22; offset >= earliestEocd; offset--) {
    if (readU32(archive, offset) !== 0x06054b50) continue;
    const commentLength = readU16(archive, offset + 20);
    if (offset + 22 + commentLength === archive.length) {
      eocdOffset = offset;
      break;
    }
  }
  if (eocdOffset < 0) invalid();

  const diskNumber = readU16(archive, eocdOffset + 4);
  const centralDisk = readU16(archive, eocdOffset + 6);
  const entriesOnDisk = readU16(archive, eocdOffset + 8);
  const entryCount = readU16(archive, eocdOffset + 10);
  const centralSize = readU32(archive, eocdOffset + 12);
  const centralOffset = readU32(archive, eocdOffset + 16);
  if (diskNumber !== 0 || centralDisk !== 0 || entriesOnDisk !== 1 || entryCount !== 1) invalid();
  if (centralSize === 0xffffffff || centralOffset === 0xffffffff || centralOffset + centralSize !== eocdOffset) invalid();
  ensureRange(archive, centralOffset, centralSize, eocdOffset);
  if (centralSize < 46 || readU32(archive, centralOffset, eocdOffset) !== 0x02014b50) invalid();

  const madeBy = readU16(archive, centralOffset + 4, eocdOffset);
  const versionNeeded = readU16(archive, centralOffset + 6, eocdOffset);
  const flags = readU16(archive, centralOffset + 8, eocdOffset);
  const method = readU16(archive, centralOffset + 10, eocdOffset);
  const checksum = readU32(archive, centralOffset + 16, eocdOffset);
  const compressedSize = readU32(archive, centralOffset + 20, eocdOffset);
  const uncompressedSize = readU32(archive, centralOffset + 24, eocdOffset);
  const nameLength = readU16(archive, centralOffset + 28, eocdOffset);
  const extraLength = readU16(archive, centralOffset + 30, eocdOffset);
  const commentLength = readU16(archive, centralOffset + 32, eocdOffset);
  const startDisk = readU16(archive, centralOffset + 34, eocdOffset);
  const externalAttributes = readU32(archive, centralOffset + 38, eocdOffset);
  const localOffset = readU32(archive, centralOffset + 42, eocdOffset);
  const centralRecordLength = 46 + nameLength + extraLength + commentLength;
  ensureRange(archive, centralOffset, centralRecordLength, eocdOffset);
  if (centralRecordLength !== centralSize || commentLength !== 0 || startDisk !== 0 || localOffset !== 0) invalid();
  if (versionNeeded > 45 || compressedSize === 0xffffffff || uncompressedSize === 0xffffffff) invalid();
  if (compressedSize > MAX_GRAPHRAG_ARCHIVE_BYTES || uncompressedSize > MAX_GRAPHRAG_RECEIPT_BYTES) invalid();
  if (method !== 0 && method !== 8) invalid();
  const allowedFlags = 0x0008 | 0x0800 | (method === 8 ? 0x0006 : 0);
  if ((flags & ~allowedFlags) !== 0) invalid();
  if (externalAttributes & 0x10) invalid();
  const operatingSystem = madeBy >>> 8;
  if (operatingSystem === 3 || operatingSystem === 19) {
    const unixMode = externalAttributes >>> 16;
    const fileType = unixMode & 0xf000;
    if (fileType !== 0 && fileType !== 0x8000) invalid();
  }

  const expectedName = Buffer.from('receipt.json', 'ascii');
  const centralNameOffset = centralOffset + 46;
  ensureRange(archive, centralNameOffset, nameLength, eocdOffset);
  if (nameLength !== expectedName.length || !archive.subarray(centralNameOffset, centralNameOffset + nameLength).equals(expectedName)) invalid();
  validateExtraFields(archive, centralNameOffset + nameLength, extraLength);

  if (readU32(archive, localOffset) !== 0x04034b50) invalid();
  const localVersionNeeded = readU16(archive, localOffset + 4);
  const localFlags = readU16(archive, localOffset + 6);
  const localMethod = readU16(archive, localOffset + 8);
  const localChecksum = readU32(archive, localOffset + 14);
  const localCompressedSize = readU32(archive, localOffset + 18);
  const localUncompressedSize = readU32(archive, localOffset + 22);
  const localNameLength = readU16(archive, localOffset + 26);
  const localExtraLength = readU16(archive, localOffset + 28);
  if (localVersionNeeded !== versionNeeded || localFlags !== flags || localMethod !== method || localNameLength !== nameLength) invalid();
  ensureRange(archive, localOffset + 30, localNameLength + localExtraLength, centralOffset);
  const localNameOffset = localOffset + 30;
  if (!archive.subarray(localNameOffset, localNameOffset + localNameLength).equals(expectedName)) invalid();
  validateExtraFields(archive, localNameOffset + localNameLength, localExtraLength);

  const hasDataDescriptor = (flags & 0x0008) !== 0;
  if (hasDataDescriptor) {
    if ((localChecksum !== 0 && localChecksum !== checksum) || (localCompressedSize !== 0 && localCompressedSize !== compressedSize) || (localUncompressedSize !== 0 && localUncompressedSize !== uncompressedSize)) invalid();
  } else if (localChecksum !== checksum || localCompressedSize !== compressedSize || localUncompressedSize !== uncompressedSize) {
    invalid();
  }

  const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
  ensureRange(archive, dataOffset, compressedSize, centralOffset);
  const dataEnd = dataOffset + compressedSize;
  if (hasDataDescriptor) {
    let descriptorOffset = dataEnd;
    if (readU32(archive, descriptorOffset, centralOffset) === 0x08074b50) descriptorOffset += 4;
    if (readU32(archive, descriptorOffset, centralOffset) !== checksum ||
        readU32(archive, descriptorOffset + 4, centralOffset) !== compressedSize ||
        readU32(archive, descriptorOffset + 8, centralOffset) !== uncompressedSize ||
        descriptorOffset + 12 !== centralOffset) invalid();
  } else if (dataEnd !== centralOffset) {
    invalid();
  }

  const compressed = archive.subarray(dataOffset, dataEnd);
  let receipt: Buffer;
  try {
    receipt = method === 0 ? Buffer.from(compressed) : inflateRawSync(compressed, { maxOutputLength: MAX_GRAPHRAG_RECEIPT_BYTES });
  } catch {
    return invalid();
  }
  if (receipt.length !== uncompressedSize || receipt.length > MAX_GRAPHRAG_RECEIPT_BYTES || crc32(receipt) !== checksum) invalid();
  return receipt;
}

class StrictJsonScanner {
  private offset = 0;
  private nodes = 0;
  private static readonly numberPattern = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;

  constructor(private readonly input: string) {}

  scan(): void {
    this.readValue(0);
    this.skipWhitespace();
    if (this.offset !== this.input.length) invalid();
  }

  private skipWhitespace(): void {
    while (this.offset < this.input.length && /[\u0009\u000a\u000d\u0020]/.test(this.input[this.offset]!)) this.offset++;
  }

  private readString(): string {
    const start = this.offset;
    if (this.input[this.offset] !== '"') invalid();
    this.offset++;
    while (this.offset < this.input.length) {
      const code = this.input.charCodeAt(this.offset);
      if (code === 0x22) {
        this.offset++;
        try {
          return JSON.parse(this.input.slice(start, this.offset)) as string;
        } catch {
          return invalid();
        }
      }
      if (code < 0x20) invalid();
      if (code === 0x5c) {
        this.offset++;
        const escape = this.input[this.offset];
        if (escape === 'u') {
          const hex = this.input.slice(this.offset + 1, this.offset + 5);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) invalid();
          this.offset += 5;
          continue;
        }
        if (!escape || !'"\\/bfnrt'.includes(escape)) invalid();
      }
      this.offset++;
    }
    return invalid();
  }

  private readValue(depth: number): void {
    this.skipWhitespace();
    if (depth > 32 || ++this.nodes > 4096) invalid();
    const char = this.input[this.offset];
    if (char === '"') {
      this.readString();
      return;
    }
    if (char === '{') {
      this.readObject(depth + 1);
      return;
    }
    if (char === '[') {
      this.readArray(depth + 1);
      return;
    }
    if (char === 't' && this.input.startsWith('true', this.offset)) {
      this.offset += 4;
      return;
    }
    if (char === 'f' && this.input.startsWith('false', this.offset)) {
      this.offset += 5;
      return;
    }
    if (char === 'n' && this.input.startsWith('null', this.offset)) {
      this.offset += 4;
      return;
    }
    StrictJsonScanner.numberPattern.lastIndex = this.offset;
    const match = StrictJsonScanner.numberPattern.exec(this.input);
    if (!match) invalid();
    this.offset += match[0].length;
  }

  private readObject(depth: number): void {
    this.offset++;
    this.skipWhitespace();
    if (this.input[this.offset] === '}') {
      this.offset++;
      return;
    }
    const keys = new Set<string>();
    while (this.offset < this.input.length) {
      this.skipWhitespace();
      const key = this.readString();
      if (keys.has(key)) invalid();
      keys.add(key);
      this.skipWhitespace();
      if (this.input[this.offset] !== ':') invalid();
      this.offset++;
      this.readValue(depth);
      this.skipWhitespace();
      const delimiter = this.input[this.offset++];
      if (delimiter === '}') return;
      if (delimiter !== ',') invalid();
    }
    invalid();
  }

  private readArray(depth: number): void {
    this.offset++;
    this.skipWhitespace();
    if (this.input[this.offset] === ']') {
      this.offset++;
      return;
    }
    while (this.offset < this.input.length) {
      this.readValue(depth);
      this.skipWhitespace();
      const delimiter = this.input[this.offset++];
      if (delimiter === ']') return;
      if (delimiter !== ',') invalid();
    }
    invalid();
  }
}

export function parseStrictJson(text: string, maxBytes = MAX_GRAPHRAG_RECEIPT_BYTES): unknown {
  if (Buffer.byteLength(text, 'utf8') > maxBytes) invalid();
  try {
    new StrictJsonScanner(text).scan();
    return JSON.parse(text) as unknown;
  } catch {
    return invalid();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireExactKeys(record: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(record);
  if (actual.length !== expected.length || actual.some((key) => !expected.includes(key))) invalid();
}

function validateStatistics(value: unknown, keys: readonly string[], exact: boolean): ObservationStatistics {
  if (!isRecord(value)) invalid();
  if (exact) requireExactKeys(value, keys);
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) invalid();
    const count = value[key];
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) invalid();
  }
  return Object.fromEntries(Object.entries(value)) as ObservationStatistics;
}

export function validatePinnedObservationReceipt(receiptBytes: Buffer): ValidatedObservationReceipt {
  if (receiptBytes.length === 0 || receiptBytes.length > MAX_GRAPHRAG_RECEIPT_BYTES) invalid();
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(receiptBytes);
  } catch {
    return invalid();
  }
  const parsed = parseStrictJson(text);
  if (!isRecord(parsed)) invalid();
  requireExactKeys(parsed, [
    'schema',
    'read_only',
    'knowledge_base_id',
    'source_id',
    'ingestion_job_id',
    'provider_status',
    'provider_updated_at',
    'terminal',
    'terminal_statistics',
    'progress_statistics',
  ]);
  if (parsed.schema !== PINNED_GRAPHRAG_OBSERVATION.receiptSchema || parsed.read_only !== true ||
      parsed.knowledge_base_id !== PINNED_GRAPHRAG_OBSERVATION.knowledgeBaseId ||
      parsed.source_id !== PINNED_GRAPHRAG_OBSERVATION.sourceId ||
      parsed.ingestion_job_id !== PINNED_GRAPHRAG_OBSERVATION.ingestionJobId) invalid();

  if (typeof parsed.provider_status !== 'string' || parsed.provider_status.length === 0 || parsed.provider_status.length > 64 ||
      /[\u0000-\u001f\u007f]/.test(parsed.provider_status)) invalid();
  const terminal = TERMINAL_STATUSES.has(parsed.provider_status);
  if (parsed.terminal !== terminal) invalid();

  let updatedAtPresent = false;
  if (parsed.provider_updated_at !== null) {
    if (typeof parsed.provider_updated_at !== 'string' || parsed.provider_updated_at.length === 0 ||
        parsed.provider_updated_at.length > 64 || /[\u0000-\u001f\u007f]/.test(parsed.provider_updated_at)) invalid();
    updatedAtPresent = true;
  }

  let terminalStatistics: ObservationStatistics | null = null;
  let progressStatistics: ObservationStatistics | null = null;
  if (terminal) {
    if (parsed.progress_statistics !== null) invalid();
    terminalStatistics = validateStatistics(parsed.terminal_statistics, TERMINAL_STATISTIC_KEYS, true);
  } else {
    if (parsed.terminal_statistics !== null) invalid();
    if (parsed.progress_statistics !== null) {
      progressStatistics = validateStatistics(parsed.progress_statistics, PROGRESS_STATISTIC_KEYS, false);
    }
  }

  return {
    receipt_schema: PINNED_GRAPHRAG_OBSERVATION.receiptSchema,
    read_only: true,
    source_id: PINNED_GRAPHRAG_OBSERVATION.sourceId,
    ingestion_job_id: PINNED_GRAPHRAG_OBSERVATION.ingestionJobId,
    provider_status: terminal ? parsed.provider_status as 'COMPLETE' | 'FAILED' | 'STOPPED' : 'NONTERMINAL',
    terminal,
    terminal_statistics: terminalStatistics,
    progress_statistics: progressStatistics,
    provider_updated_at_present: updatedAtPresent,
  };
}
