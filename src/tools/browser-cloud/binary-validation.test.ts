import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { createTrustedBrowserBinaryValidator } from './binary-validation.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==', 'base64');
const jpeg = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAACAAIDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDi6KKK+ZP3E//Z', 'base64');

// Minimal syntactically complete PDF fixture with computed xref offsets and a real page tree.
function makePdf(): Buffer {
  let text = '%PDF-1.4\n';
  const offsets = [0];
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 10 10] >>',
  ];
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(Buffer.byteLength(text));
    text += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(text);
  text += `xref\n0 4\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Root 1 0 R /Size 4 >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(text);
}
const pdf = makePdf();
const qpdfAvailable = spawnSync('qpdf', ['--version'], { stdio: 'ignore' }).status === 0 &&
  spawnSync('prlimit', ['--version'], { stdio: 'ignore' }).status === 0;

test('fully decodes a complete PNG and JPEG', async () => {
  const validator = createTrustedBrowserBinaryValidator();
  assert.deepEqual(await validator.validate({ contentType: 'image/png', body: png }), { complete: true });
  assert.deepEqual(await validator.validate({ contentType: 'image/jpeg', body: jpeg }), { complete: true });
});

test('qpdf verifies PDF syntax and obtains the structural page count', async () => {
  const calls: Array<{ file: string; args: readonly string[]; timeoutMs: number; maxOutputBytes: number }> = [];
  const validator = createTrustedBrowserBinaryValidator({
    runTool: async (file, args, timeoutMs, maxOutputBytes) => {
      calls.push({ file, args, timeoutMs, maxOutputBytes });
      return { stdout: 'checking file\nNo syntax or stream encoding errors found\n1\n', stderr: '' };
    },
  });
  assert.deepEqual(await validator.validate({ contentType: 'application/pdf', body: pdf }), { complete: true, pageCount: 1 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.file, 'prlimit');
  assert.deepEqual(calls[0]!.args.slice(0, 6), [
    '--as=536870912:536870912', '--cpu=4:4', '--', 'qpdf', '--check', '--show-npages',
  ]);
  assert.equal(calls[0]!.timeoutMs, 5_000);
  assert.equal(calls[0]!.maxOutputBytes, 32 * 1024);
});

test('real qpdf accepts a valid PDF and rejects truncated and malformed PDFs', { skip: !qpdfAvailable }, async () => {
  const validator = createTrustedBrowserBinaryValidator();
  assert.deepEqual(await validator.validate({ contentType: 'application/pdf', body: pdf }), { complete: true, pageCount: 1 });
  await assert.rejects(validator.validate({ contentType: 'application/pdf', body: pdf.subarray(0, pdf.length - 10) }));
  await assert.rejects(validator.validate({ contentType: 'application/pdf', body: Buffer.from('%PDF-1.7\nnot really a PDF\n%%EOF') }));
});

test('rejects fake PDF markers, truncated and corrupt images, and mismatched types', async () => {
  const validator = createTrustedBrowserBinaryValidator({ runTool: async () => ({ stdout: '1\n', stderr: '' }) });
  await assert.rejects(validator.validate({ contentType: 'application/pdf', body: Buffer.from('%PDF-1.7\nnot really a PDF\n%%EOF') }));
  await assert.rejects(validator.validate({ contentType: 'image/png', body: png.subarray(0, png.length - 8) }));
  const corruptPng = Buffer.from(png); corruptPng[30] ^= 0x80;
  await assert.rejects(validator.validate({ contentType: 'image/png', body: corruptPng }));
  await assert.rejects(validator.validate({ contentType: 'image/png', body: jpeg }));
});

test('rejects oversized decoded dimensions before image allocation', async () => {
  const bomb = Buffer.from(png);
  bomb.writeUInt32BE(5000, 16); bomb.writeUInt32BE(5000, 20);
  await assert.rejects(createTrustedBrowserBinaryValidator().validate({ contentType: 'image/png', body: bomb }));
});

test('fails closed on missing tool, timeout, bad qpdf output, and redacts tool secrets', async () => {
  const missing = createTrustedBrowserBinaryValidator({ runTool: async () => { throw new Error('qpdf missing /secret/path/private.pdf'); } });
  await assert.rejects(missing.validate({ contentType: 'application/pdf', body: pdf }), /validation unavailable/i);
  const timeout = createTrustedBrowserBinaryValidator({ runTool: async () => { throw Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }); } });
  await assert.rejects(timeout.validate({ contentType: 'application/pdf', body: pdf }), /validation unavailable/i);
  const malformed = createTrustedBrowserBinaryValidator({ runTool: async () => ({ stdout: '1000\n', stderr: 'private detail' }) });
  await assert.rejects(malformed.validate({ contentType: 'application/pdf', body: pdf }), (e: unknown) => !String(e).includes('private detail') && /validation unavailable/i.test(String(e)));
  const wrongPageCount = createTrustedBrowserBinaryValidator({ runTool: async () => ({ stdout: 'No syntax or stream encoding errors found\n101\n', stderr: '' }) });
  await assert.rejects(wrongPageCount.validate({ contentType: 'application/pdf', body: pdf }));
  await assert.rejects(createTrustedBrowserBinaryValidator().validate({ contentType: 'image/png', body: Buffer.alloc(10 * 1024 * 1024 + 1) }));
});
