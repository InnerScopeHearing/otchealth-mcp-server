import { execFile as nodeExecFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const MAX_BINARY_BYTES = 10 * 1024 * 1024;
const MAX_CAPTURE_BYTES = 4 * 1024 * 1024;
const MAX_STDOUT_BYTES = 32 * 1024;
// Stream bodies are omitted; bound the complete decoded object inventory separately.
const MAX_PDF_JSON_BYTES = 4 * 1024 * 1024;
const TOOL_TIMEOUT_MS = 5_000;
const MAX_IMAGE_PIXELS = 16_000_000;

export type BrowserBinaryValidationInput = { contentType: string; body: Uint8Array };
export type BrowserBinaryValidationResult = { complete: true; pageCount?: number };

type ToolResult = { stdout: string; stderr: string };
type TrustedToolRunner = (file: string, args: readonly string[], timeoutMs: number, maxOutputBytes: number) => Promise<ToolResult>;

export interface TrustedBrowserBinaryValidator {
  validate(input: BrowserBinaryValidationInput): Promise<BrowserBinaryValidationResult>;
}

export interface TrustedBrowserBinaryValidatorOptions {
  /** Test seam for a trusted executable; never populate this from a request. */
  runTool?: TrustedToolRunner;
}

const defaultRunTool: TrustedToolRunner = async (file, args, timeoutMs, maxOutputBytes) => {
  const execFile = promisify(nodeExecFile);
  const result = await execFile(file, [...args], {
    shell: false,
    timeout: timeoutMs,
    maxBuffer: maxOutputBytes,
    encoding: 'utf8',
    windowsHide: true,
  });
  return { stdout: result.stdout, stderr: result.stderr };
};

// This source is constant. The only variable is a generated path inside our private temp directory.
const PILLOW_DECODE_SCRIPT = String.raw`
import os, resource, sys, warnings
resource.setrlimit(resource.RLIMIT_CPU, (3, 3))
resource.setrlimit(resource.RLIMIT_AS, (512 * 1024 * 1024, 512 * 1024 * 1024))
from PIL import Image, ImageFile
Image.MAX_IMAGE_PIXELS = 16000000
ImageFile.LOAD_TRUNCATED_IMAGES = False
warnings.simplefilter('error', Image.DecompressionBombWarning)
path, expected = sys.argv[1], sys.argv[2]
with Image.open(path) as image:
    actual = image.format
    width, height = image.size
    if actual != expected or width <= 0 or height <= 0 or width * height > 16000000:
        raise ValueError('invalid image bounds or format')
    image.verify()
with Image.open(path) as image:
    if image.format != expected:
        raise ValueError('format changed')
    image.load()
    if image.size != (width, height):
        raise ValueError('dimensions changed')
print(actual, width, height)
`;

function validInput(input: BrowserBinaryValidationInput): boolean {
  if (!input || typeof input !== 'object' || !(input.body instanceof Uint8Array)) return false;
  const limit = input.contentType === 'application/pdf' ? MAX_CAPTURE_BYTES : MAX_BINARY_BYTES;
  return input.body.byteLength > 0 && input.body.byteLength <= limit &&
    ['application/pdf', 'image/png', 'image/jpeg'].includes(input.contentType);
}

function dictionary(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertPdfHasNoAttachments(output: string): void {
  if (Buffer.byteLength(output, 'utf8') > MAX_PDF_JSON_BYTES) throw new Error('invalid binary');
  const document: unknown = JSON.parse(output);
  if (!dictionary(document) || document.version !== 2 || !dictionary(document.attachments) ||
      Object.keys(document.attachments).length !== 0 || !Array.isArray(document.qpdf) || document.qpdf.length !== 2 ||
      !dictionary(document.qpdf[0]) || document.qpdf[0].jsonversion !== 2 ||
      !dictionary(document.qpdf[1]) || !dictionary(document.qpdf[1].trailer)) throw new Error('invalid binary');

  const objects = document.qpdf[1];
  let remainingReferenceSteps = 100_000;
  // JSON2 preserves indirect values. Resolve only the fields inspected below,
  // not arbitrary graph edges: ordinary PDF page/parent references contain cycles.
  const resolve = (input: unknown): unknown => {
    let value = input;
    const seen = new Set<string>();
    while (typeof value === 'string' && /^[1-9][0-9]* [0-9]+ R$/.test(value)) {
      if (seen.size >= 32 || seen.has(value) || remainingReferenceSteps-- <= 0) throw new Error('invalid binary');
      seen.add(value);
      const object = objects[`obj:${value}`];
      if (!dictionary(object)) throw new Error('invalid binary');
      if (Object.hasOwn(object, 'value') && !Object.hasOwn(object, 'stream')) value = object.value;
      else if (dictionary(object.stream) && dictionary(object.stream.dict) && !Object.hasOwn(object, 'value')) value = object.stream.dict;
      else throw new Error('invalid binary');
    }
    return value;
  };
  const trailer = objects.trailer;
  if (!dictionary(trailer) || !dictionary(trailer.value)) throw new Error('invalid binary');
  const catalog = resolve(trailer.value['/Root']);
  if (!dictionary(catalog)) throw new Error('invalid binary');
  const fileKeys = ['/F', '/UF', '/DOS', '/Mac', '/Unix'];
  const hasFilename = (value: Record<string, unknown>): boolean => fileKeys.some(key => {
    const filename = resolve(value[key]);
    return typeof filename === 'string' && /^(?:u:|b:)/.test(filename);
  });
  const hasEmbeddedFileMap = (value: Record<string, unknown>): boolean => {
    const embeddedFiles = resolve(value['/EF']);
    return dictionary(embeddedFiles) && fileKeys.some(key => Object.hasOwn(embeddedFiles, key));
  };
  const isFileSpecification = (input: unknown): boolean => {
    const value = resolve(input);
    return dictionary(value) && (resolve(value['/Type']) === '/Filespec' || hasFilename(value) || hasEmbeddedFileMap(value));
  };

  // qpdf decodes escaped names and inventories orphan objects too. Match actual
  // dictionary roles/value shapes, not arbitrary resource aliases such as /Font /AF.
  // This refuses embedded/associated files and portfolios; it is not an AV verdict.
  const pending: unknown[] = [objects];
  while (pending.length > 0) {
    const value = pending.pop();
    if (Array.isArray(value)) {
      for (const child of value) pending.push(child);
    } else if (dictionary(value)) {
      const type = resolve(value['/Type']);
      if (type === '/EmbeddedFile' || resolve(value['/Subtype']) === '/FileAttachment') throw new Error('invalid binary');
      if (value === catalog || type === '/Catalog') {
        if (Object.hasOwn(value, '/Collection')) throw new Error('invalid binary');
        const names = resolve(value['/Names']);
        if (dictionary(names) && Object.hasOwn(names, '/EmbeddedFiles')) throw new Error('invalid binary');
      }
      const associatedFiles = resolve(value['/AF']);
      if (Array.isArray(associatedFiles) && (value === catalog ||
          ['/Catalog', '/Page', '/Pages', '/Annot', '/StructElem', '/XObject'].includes(String(type)) ||
          associatedFiles.some(isFileSpecification))) throw new Error('invalid binary');
      if (Object.hasOwn(value, '/EF')) {
        if (type === '/Filespec' || hasFilename(value) || hasEmbeddedFileMap(value)) throw new Error('invalid binary');
      }
      for (const child of Object.values(value)) pending.push(child);
    }
  }
}

/**
 * Creates the server-only structural validator used by browser captures and staged binary uploads.
 * Structural completeness does not scan for malware and must not be described as an antivirus verdict.
 */
export function createTrustedBrowserBinaryValidator(options: TrustedBrowserBinaryValidatorOptions = {}): TrustedBrowserBinaryValidator {
  const runTool = options.runTool ?? defaultRunTool;
  return {
    async validate(input): Promise<BrowserBinaryValidationResult> {
      if (!validInput(input)) throw new Error('Binary validation unavailable.');
      let workDir: string | undefined;
      try {
        workDir = await mkdtemp(join(tmpdir(), 'browser-binary-validation-'));
        const filePath = join(workDir, 'input.bin');
        // Copy to an owned file so parsers see a stable bounded snapshot, not caller memory.
        const body = Buffer.from(input.body);
        await writeFile(filePath, body, { flag: 'wx', mode: 0o600 });

        if (input.contentType === 'application/pdf') {
          // prlimit applies address-space and CPU ceilings to qpdf and all of its descendants.
          // Keep this wrapper and its options fixed; neither executable nor args are caller input.
          const result = await runTool('prlimit', [
            '--as=536870912:536870912',
            '--cpu=4:4',
            '--',
            'qpdf',
            '--check',
            '--show-npages',
            filePath,
          ], TOOL_TIMEOUT_MS, MAX_STDOUT_BYTES);
          const lines = result.stdout.trim().split(/\r?\n/);
          const pageCount = Number(lines.at(-1));
          if (!/No syntax or stream encoding errors found/i.test(result.stdout) ||
              !Number.isSafeInteger(pageCount) || pageCount < 1 || pageCount > 100) {
            throw new Error('invalid binary');
          }
          const inspection = await runTool('prlimit', [
            '--as=536870912:536870912', '--cpu=4:4', '--', 'qpdf', '--json=2',
            '--json-key=attachments', '--json-key=qpdf', '--json-stream-data=none', filePath,
          ], TOOL_TIMEOUT_MS, MAX_PDF_JSON_BYTES);
          assertPdfHasNoAttachments(inspection.stdout);
          return { complete: true, pageCount };
        }

        const expectedFormat = input.contentType === 'image/png' ? 'PNG' : 'JPEG';
        const result = await runTool('python3', ['-c', PILLOW_DECODE_SCRIPT, filePath, expectedFormat], TOOL_TIMEOUT_MS, MAX_STDOUT_BYTES);
        const match = /^((?:PNG)|(?:JPEG)) ([1-9][0-9]*) ([1-9][0-9]*)\s*$/.exec(result.stdout);
        if (!match || match[1] !== expectedFormat) throw new Error('invalid binary');
        const width = Number(match[2]);
        const height = Number(match[3]);
        if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width * height > MAX_IMAGE_PIXELS) throw new Error('invalid binary');
        return { complete: true };
      } catch {
        // Never expose parser diagnostics, filenames, command lines, or stderr to callers.
        throw new Error('Binary validation unavailable.');
      } finally {
        if (workDir) {
          try { await rm(workDir, { recursive: true, force: true }); } catch { /* preserve the generic validation result */ }
        }
      }
    },
  };
}
