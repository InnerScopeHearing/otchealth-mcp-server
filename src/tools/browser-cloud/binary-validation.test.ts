import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { createTrustedBrowserBinaryValidator } from './binary-validation.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==', 'base64');
const jpeg = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAACAAIDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDi6KKK+ZP3E//Z', 'base64');

// Minimal syntactically complete PDF fixture with computed xref offsets and a real page tree.
function makePdf(catalog = '', extraObjects: string[] = [], page = ''): Buffer {
  let text = '%PDF-1.4\n';
  const offsets = [0];
  const objects = [
    `<< /Type /Catalog /Pages 2 0 R ${catalog} >>`,
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 10 10] ${page} >>`,
    ...extraObjects,
  ];
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(Buffer.byteLength(text));
    text += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(text);
  text += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Root 1 0 R /Size ${objects.length + 1} >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(text);
}
const pdf = makePdf();
const syntaxOutput = 'checking file\nNo syntax or stream encoding errors found\n1\n';
const jsonOutput = (value: unknown = { '/Type': '/Catalog' }, attachments: unknown = {}) => JSON.stringify({
  version: 2, attachments, qpdf: [{ jsonversion: 2 }, { 'obj:1 0 R': { value }, trailer: { value: { '/Root': '1 0 R' } } }],
});
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
      return { stdout: args.includes('--json=2') ? jsonOutput() : syntaxOutput, stderr: '' };
    },
  });
  assert.deepEqual(await validator.validate({ contentType: 'application/pdf', body: pdf }), { complete: true, pageCount: 1 });
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.file, 'prlimit');
  assert.deepEqual(calls[0]!.args.slice(0, 6), [
    '--as=536870912:536870912', '--cpu=4:4', '--', 'qpdf', '--check', '--show-npages',
  ]);
  assert.equal(calls[0]!.timeoutMs, 5_000);
  assert.equal(calls[0]!.maxOutputBytes, 32 * 1024);
  assert.deepEqual(calls[1]!.args.slice(0, 8), [
    '--as=536870912:536870912', '--cpu=4:4', '--', 'qpdf', '--json=2',
    '--json-key=attachments', '--json-key=qpdf', '--json-stream-data=none',
  ]);
  assert.equal(calls[1]!.maxOutputBytes, 4 * 1024 * 1024);
});

test('rejects PDF attachment dictionaries even when syntax and antivirus are clean', async () => {
  for (const value of [
    { '/EF': { '/F': '2 0 R' } }, { '/AF': ['2 0 R'] }, { '/Names': { '/EmbeddedFiles': {} } },
    { '/Collection': {} }, { '/Type': '/EmbeddedFile' }, { '/Subtype': '/FileAttachment' },
    { '/Nested': [{ '/Type': '/Filespec', '/EF': {} }] },
  ]) {
    const validator = createTrustedBrowserBinaryValidator({ runTool: async (_file, args) => ({ stdout: args.includes('--json=2') ? jsonOutput(value) : syntaxOutput, stderr: '' }) });
    await assert.rejects(validator.validate({ contentType: 'application/pdf', body: pdf }), /validation unavailable/i);
  }
  const named = createTrustedBrowserBinaryValidator({ runTool: async (_file, args) => ({ stdout: args.includes('--json=2') ? jsonOutput({}, { 'file.txt': {} }) : syntaxOutput, stderr: '' }) });
  await assert.rejects(named.validate({ contentType: 'application/pdf', body: pdf }));
});

test('fails closed on missing, malformed, or oversized attachment inspection', async () => {
  for (const output of ['', '{}', '{', JSON.stringify({ version: 2, attachments: {}, qpdf: [] }), jsonOutput({}, []), ' '.repeat(4 * 1024 * 1024 + 1)]) {
    const validator = createTrustedBrowserBinaryValidator({ runTool: async (_file, args) => ({ stdout: args.includes('--json=2') ? output : syntaxOutput, stderr: 'private parser detail' }) });
    await assert.rejects(validator.validate({ contentType: 'application/pdf', body: pdf }), /^Error: Binary validation unavailable\.$/);
  }
});

test('preserves ordinary PDF dictionaries and text mentioning attachment names', async () => {
  const output = jsonOutput({ '/Title': 'u:/EmbeddedFiles /EF /AF /Collection', '/Metadata': '2 0 R', '/Annots': [{ '/Subtype': '/Link' }], '/Font': { '/F1': '3 0 R' } });
  const validator = createTrustedBrowserBinaryValidator({ runTool: async (_file, args) => ({ stdout: args.includes('--json=2') ? output : syntaxOutput, stderr: '' }) });
  assert.deepEqual(await validator.validate({ contentType: 'application/pdf', body: pdf }), { complete: true, pageCount: 1 });
});

test('rejects indirect attachment names and fails closed on cyclic, missing, and overlong inspected references', async () => {
  for (const field of ['/Type', '/Subtype']) {
    for (const references of [
      { 'obj:4 0 R': { value: field === '/Type' ? '/EmbeddedFile' : '/FileAttachment' } },
      { 'obj:4 0 R': { value: '5 0 R' }, 'obj:5 0 R': { value: field === '/Type' ? '/EmbeddedFile' : '/FileAttachment' } },
      { 'obj:4 0 R': { value: '5 0 R' }, 'obj:5 0 R': { value: '4 0 R' } },
      {},
      Object.fromEntries(Array.from({ length: 34 }, (_, index) => [`obj:${index + 4} 0 R`, { value: index === 33 ? '/Font' : `${index + 5} 0 R` }])),
    ]) {
      const document = JSON.parse(jsonOutput({ [field]: '4 0 R' }));
      Object.assign(document.qpdf[1], references);
      const validator = createTrustedBrowserBinaryValidator({ runTool: async (_file, args) => ({ stdout: args.includes('--json=2') ? JSON.stringify(document) : syntaxOutput, stderr: '' }) });
      await assert.rejects(validator.validate({ contentType: 'application/pdf', body: pdf }), /validation unavailable/i);
    }
  }
});

test('real qpdf rejects indirect EmbeddedFile and FileAttachment names after valid syntax checks', { skip: !qpdfAvailable }, async () => {
  let inspections = 0;
  const validator = createTrustedBrowserBinaryValidator({ runTool: async (file, args, timeout, maxBuffer) => {
    const result = spawnSync(file, [...args], { encoding: 'utf8', timeout, maxBuffer });
    if (result.status !== 0) throw new Error('local parser failed');
    if (args.includes('--json=2')) inspections += 1;
    return { stdout: result.stdout, stderr: result.stderr };
  } });
  for (const body of [
    makePdf('', ['<< /Type 5 0 R /Length 4 >>\nstream\ntest\nendstream', '/EmbeddedFile']),
    makePdf('', ['<< /Type /Annot /Subtype 5 0 R /Rect [0 0 1 1] >>', '/FileAttachment'], '/Annots [4 0 R]'),
  ]) await assert.rejects(validator.validate({ contentType: 'application/pdf', body }));
  assert.equal(inspections, 2);
});

test('real qpdf preserves legal font resource aliases matching attachment field names', { skip: !qpdfAvailable }, async () => {
  const aliases = ['/AF', '/EF', '/EmbeddedFiles', '/Collection', '/Type', '/Subtype'];
  const font = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  for (const indirect of [false, true]) {
    const body = makePdf('', [font, ...(indirect ? [`<< ${aliases.map(name => `${name} 4 0 R`).join(' ')} >>`] : [])],
      `/Resources << /Font ${indirect ? '5 0 R' : `<< ${aliases.map(name => `${name} 4 0 R`).join(' ')} >>`} >>`);
    assert.deepEqual(await createTrustedBrowserBinaryValidator().validate({ contentType: 'application/pdf', body }), { complete: true, pageCount: 1 });
  }
});

test('real qpdf preserves an AF color-space alias containing a valid PDF array', { skip: !qpdfAvailable }, async () => {
  const body = makePdf('', [], '/Resources << /ColorSpace << /AF [/Indexed /DeviceRGB 1 <000000FFFFFF>] >> >>');
  assert.deepEqual(await createTrustedBrowserBinaryValidator().validate({ contentType: 'application/pdf', body }), { complete: true, pageCount: 1 });
});

test('real qpdf rejects associated and orphan filespecs without optional Type names', { skip: !qpdfAvailable }, async () => {
  const filespec = '<< /F (test.txt) /EF << /F 5 0 R >> >>';
  const stream = '<< /Length 4 >>\nstream\ntest\nendstream';
  for (const catalog of ['', '/AF [4 0 R]']) {
    await assert.rejects(createTrustedBrowserBinaryValidator().validate({ contentType: 'application/pdf', body: makePdf(catalog, [filespec, stream]) }));
  }
});

test('real qpdf rejects named, associated, annotation, orphan, and escaped-name attachments', { skip: !qpdfAvailable }, async () => {
  const filespec = '<< /Type /Filespec /F (test.txt) /EF << /F 5 0 R >> >>';
  const embedded = '<< /Type /EmbeddedFile /Length 4 >>\nstream\ntest\nendstream';
  const bodies = [
    makePdf('/Names << /EmbeddedFiles << /Names [(test.txt) 4 0 R] >> >>', [filespec, embedded]),
    makePdf('/AF [4 0 R]', [filespec, embedded]),
    makePdf('', [filespec, embedded, '<< /Type /Annot /Subtype /FileAttachment /FS 4 0 R >>'], '/Annots [6 0 R]'),
    makePdf('', [filespec, embedded]),
    makePdf('/A#46 [4 0 R]', [filespec.replace('/EF', '/E#46'), embedded.replace('/EmbeddedFile', '/Embedded#46ile')]),
  ];
  let inspections = 0;
  const validator = createTrustedBrowserBinaryValidator({ runTool: async (file, args, timeout, maxBuffer) => {
    const result = spawnSync(file, [...args], { encoding: 'utf8', timeout, maxBuffer });
    if (result.status !== 0) throw new Error('local parser failed');
    if (args.includes('--json=2')) inspections += 1;
    return { stdout: result.stdout, stderr: result.stderr };
  } });
  for (const body of bodies) await assert.rejects(validator.validate({ contentType: 'application/pdf', body }));
  assert.equal(inspections, bodies.length, 'all fixtures passed structural syntax checks before policy rejection');
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
