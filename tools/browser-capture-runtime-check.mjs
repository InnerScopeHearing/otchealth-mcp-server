// Offline acceptance for the compiled capture validator and runtime parser dependencies.
// Inputs are fixed synthetic bytes. No credentials, provider calls or network access are used.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==', 'base64');
const jpeg = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAACAAIDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDi6KKK+ZP3E//Z', 'base64');

// Minimal complete PDF with generated xref offsets and a real one-page tree.
function makePdf() {
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

for (const [program, args, label] of [
  ['qpdf', ['--version'], 'qpdf'],
  ['prlimit', ['--version'], 'prlimit'],
  ['python3', ['-c', 'from PIL import Image; print(Image.__version__)'], 'Pillow'],
]) {
  const result = spawnSync(program, args, { encoding: 'utf8', timeout: 5_000 });
  assert.equal(result.error, undefined, `${label} must be installed and executable`);
  assert.equal(result.status, 0, `${label} runtime check failed`);
}

const { createTrustedBrowserBinaryValidator } = await import('../dist/tools/browser-cloud/binary-validation.js');
const validator = createTrustedBrowserBinaryValidator();
const pdf = makePdf();
assert.deepEqual(await validator.validate({ contentType: 'image/png', body: png }), { complete: true });
assert.deepEqual(await validator.validate({ contentType: 'image/jpeg', body: jpeg }), { complete: true });
assert.deepEqual(await validator.validate({ contentType: 'application/pdf', body: pdf }), { complete: true, pageCount: 1 });

await assert.rejects(validator.validate({ contentType: 'application/pdf', body: pdf.subarray(0, pdf.length - 10) }));
await assert.rejects(validator.validate({ contentType: 'application/pdf', body: Buffer.from('%PDF-1.7\nnot really a PDF\n%%EOF') }));
await assert.rejects(validator.validate({ contentType: 'image/png', body: png.subarray(0, png.length - 8) }));
const corruptPng = Buffer.from(png);
corruptPng[30] ^= 0x80;
await assert.rejects(validator.validate({ contentType: 'image/png', body: corruptPng }));
await assert.rejects(validator.validate({ contentType: 'image/png', body: jpeg }));
const dimensionBomb = Buffer.from(png);
dimensionBomb.writeUInt32BE(5_000, 16);
dimensionBomb.writeUInt32BE(5_000, 20);
await assert.rejects(validator.validate({ contentType: 'image/png', body: dimensionBomb }));

console.log(JSON.stringify({ status: 'pass', checks: 10, qpdf: true, prlimit: true, pillow: true, network: 'disabled', providers: 0 }));
