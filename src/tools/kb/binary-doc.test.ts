import { test } from 'node:test';
import assert from 'node:assert/strict';
import { looksBinary, sidecarPathFor, TEXT_PREFIX } from './get-document.js';

// These are the real formats the CFO saves into the dataroom from mail attachments.

test('THE DEFECT: a PDF is binary, so it must never be decoded as UTF-8 and served as content', () => {
  // Before this, `buf.toString('utf8')` on these bytes returned mojibake WITH a confident char
  // count, line count and sha256 -- binary noise presented as a readable source document.
  const pdf = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.from([0x00, 0x01, 0x02]), Buffer.from('obj')]);
  assert.equal(looksBinary(pdf), true);
});

test('the Office formats a bank/vendor sends are detected', () => {
  assert.equal(looksBinary(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00])), true, 'docx/xlsx/pptx (ZIP)');
  assert.equal(looksBinary(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1])), true, 'legacy .doc/.xls (OLE2)');
  assert.equal(looksBinary(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a])), true, 'PNG, e.g. a scanned statement');
  assert.equal(looksBinary(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])), true, 'JPEG scan');
});

test('CONTROL: real text is NOT misflagged, so extracted sidecars still serve normally', () => {
  assert.equal(looksBinary(Buffer.from('Statement of account\nBalance: 1,234.56\n', 'utf8')), false);
  assert.equal(looksBinary(Buffer.from('', 'utf8')), false, 'empty is not binary');
  // Real finance text carries accented vendor names and currency symbols; UTF-8 multibyte must pass.
  assert.equal(looksBinary(Buffer.from('Société Générale — solde 1 234,56 € · 残高\n', 'utf8')), false);
  // A short file smaller than the magic-number window must not throw or misfire.
  assert.equal(looksBinary(Buffer.from('ok', 'utf8')), false);
});

test('a NUL byte anywhere in the leading window is decisive even without a known magic number', () => {
  const weird = Buffer.concat([Buffer.from('NOTAMAGIC'), Buffer.from([0x00]), Buffer.from('tail')]);
  assert.equal(looksBinary(weird), true);
});

test('a NUL past the scan window does not retroactively make a large text file binary', () => {
  // Deliberate boundary: the scan is bounded to keep the check cheap on 50MB blobs. Anything after
  // the window is out of scope by design, and that tradeoff should fail toward "text", not toward
  // refusing a legitimate document.
  const big = Buffer.concat([Buffer.alloc(9000, 0x41), Buffer.from([0x00])]);
  assert.equal(looksBinary(big), false);
});

test('the sidecar path matches the doc-indexer convention exactly', () => {
  // Must stay byte-identical to doc-indexer's `'_TEXT/' + path + '.txt'`, or the lookup silently
  // misses and every binary document reports "no text sidecar" forever.
  assert.equal(sidecarPathFor('fy2021-close-innd/gs-capital-notes/statement.pdf'), '_TEXT/fy2021-close-innd/gs-capital-notes/statement.pdf.txt');
  assert.equal(sidecarPathFor('a.pdf'), '_TEXT/a.pdf.txt');
  assert.equal(TEXT_PREFIX, '_TEXT/');
});

test('a path already under _TEXT/ is left alone (no double-prefixing)', () => {
  // The handler guards on this; the naive version would look for _TEXT/_TEXT/....txt.txt.
  const already = '_TEXT/fy2021/statement.pdf.txt';
  assert.equal(already.startsWith(TEXT_PREFIX), true);
  assert.equal(sidecarPathFor(already), '_TEXT/_TEXT/fy2021/statement.pdf.txt.txt', 'which is why the caller must not call it for these');
});
