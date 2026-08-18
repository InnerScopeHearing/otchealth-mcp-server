import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';

// Same env-seeding pattern as get-document.test.ts: loadEnv() validates the WHOLE env, so seed the
// unrelated required vars before importing anything that touches config.
before(() => {
  const required: Record<string, string> = {
    CIO_SITE_ID: 'test',
    CIO_TRACK_KEY: 'test',
    CIO_APP_API_BEARER: 'test',
    PERPLEXITY_CONNECTOR_TOKEN: 'a'.repeat(32),
    ADMIN_REVOKE_TOKEN: 'b'.repeat(32),
    N8N_WEBHOOK_SECRET: 'c'.repeat(32),
  };
  for (const [k, v] of Object.entries(required)) process.env[k] ??= v;
});

const {
  resolveOriginalPath,
  hasSupportedSpreadsheetExtension,
  parseColumnRef,
  colLetter,
  classifyCell,
  summarizeSheet,
  resolveSheet,
  SheetNotFoundError,
  readRowWindow,
  loadWorkbook,
  WorkbookParseError,
  TABLE_CHAR_CAP,
  MAX_COLUMNS_RENDERED,
  MAX_PREVIEW_SHEETS,
} = await import('./get-sheet.js');
const { isLaneAllowed } = await import('./search-privileged.js');
const { isSafeBlobPath, FINANCE_DOC_INDEXES } = await import('./get-document.js');

// ---------------------------------------------------------------------------------------------
// FIXTURE: mirrors the real-world failure this tool closes — "#5.2 HA incomplete.xlsx" — a title
// row (NOT the header), a header row at row 2, formula EXT cells with cached results, a formula
// with NO cached result, an Excel error cell, a genuinely empty cell next to a real zero, a date,
// a percent, and a currency cell. Built via exceljs's own writer so the test exercises the REAL
// OOXML round-trip (write -> real zip/XML bytes -> parse), not a hand-mocked object graph.
// ---------------------------------------------------------------------------------------------
async function buildFixtureBuffer(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Inventory');

  ws.getCell('A1').value = '2022 EOY Hard Count Inventory Audit';
  ws.mergeCells('A1:D1');

  ws.getCell('A2').value = 'SKU';
  ws.getCell('B2').value = 'Listed Inventory';
  ws.getCell('C2').value = 'Price Paid';
  ws.getCell('D2').value = 'EXT';
  ws.getCell('E2').value = 'Ship Date';
  ws.getCell('F2').value = 'Discount';
  ws.getCell('G2').value = 'Unit Cost';

  // Row 3: a normal row with a formula EXT that HAS a cached result.
  ws.getCell('A3').value = 'SKU-1';
  ws.getCell('B3').value = 10;
  ws.getCell('C3').value = 3.5;
  ws.getCell('D3').value = { formula: 'B3*C3', result: 35 };
  ws.getCell('E3').value = new Date(Date.UTC(2022, 11, 31));
  ws.getCell('E3').numFmt = 'm/d/yyyy';
  ws.getCell('F3').value = 0.15;
  ws.getCell('F3').numFmt = '0.00%';
  ws.getCell('G3').value = 1234.5;
  ws.getCell('G3').numFmt = '$#,##0.00';

  // Row 4: a real zero next to a genuinely empty cell, and a formula with NO cached result.
  ws.getCell('A4').value = 'SKU-2';
  ws.getCell('B4').value = 0;
  ws.getCell('C4').value = null;
  ws.getCell('D4').value = { formula: 'B4*C4' };

  // Row 5: an Excel error cell (from a formula).
  ws.getCell('A5').value = 'SKU-3';
  ws.getCell('D5').value = { formula: 'B5/0', result: { error: '#DIV/0!' } };

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}

async function loadFixtureWorkbook(): Promise<ExcelJS.Workbook> {
  return loadWorkbook(await buildFixtureBuffer());
}

// ── Path resolution ──────────────────────────────────────────────────────────────────────────

test('resolveOriginalPath: recovers the real workbook path from a _TEXT/....txt sidecar', () => {
  assert.equal(
    resolveOriginalPath('_TEXT/innd-stock/INND-daily-stock-history.xlsx.txt'),
    'innd-stock/INND-daily-stock-history.xlsx',
  );
});

test('resolveOriginalPath: an already-real path is returned byte-identical (no regression)', () => {
  const p = 'mail-archive-attachments/fy2021-close-innd/#5.2 HA incomplete.xlsx';
  assert.equal(resolveOriginalPath(p), p);
});

test('resolveOriginalPath: a path that merely CONTAINS _TEXT/ mid-string is left alone (exact-prefix only)', () => {
  const p = 'archive/_TEXT/report.xlsx';
  assert.equal(resolveOriginalPath(p), p);
});

test('resolveOriginalPath: a _TEXT/ path NOT ending in .txt is left alone', () => {
  const p = '_TEXT/innd-stock/report.xlsx';
  assert.equal(resolveOriginalPath(p), p);
});

test('the recovered original path still passes the safety predicate', () => {
  const recovered = resolveOriginalPath('_TEXT/mail-archive-attachments/2021-12-10_TB.xlsx.txt');
  assert.equal(isSafeBlobPath(recovered), true);
});

test('hasSupportedSpreadsheetExtension: .xlsx/.xlsm accepted (case-insensitive), everything else refused', () => {
  assert.equal(hasSupportedSpreadsheetExtension('a/b/report.xlsx'), true);
  assert.equal(hasSupportedSpreadsheetExtension('a/b/REPORT.XLSX'), true);
  assert.equal(hasSupportedSpreadsheetExtension('macro.xlsm'), true);
  assert.equal(hasSupportedSpreadsheetExtension('legacy.xls'), false, 'legacy binary .xls is not OOXML');
  assert.equal(hasSupportedSpreadsheetExtension('export.csv'), false);
  assert.equal(hasSupportedSpreadsheetExtension('statement.pdf'), false);
  assert.equal(hasSupportedSpreadsheetExtension('_TEXT/report.xlsx.txt'), false, 'a sidecar path must be resolved BEFORE this check');
});

// ── Column reference parsing ─────────────────────────────────────────────────────────────────

test('parseColumnRef / colLetter round-trip for numbers and Excel letters', () => {
  assert.equal(parseColumnRef(1), 1);
  assert.equal(parseColumnRef('A'), 1);
  assert.equal(parseColumnRef('a'), 1, 'case-insensitive');
  assert.equal(parseColumnRef('Z'), 26);
  assert.equal(parseColumnRef('AA'), 27);
  assert.equal(colLetter(1), 'A');
  assert.equal(colLetter(26), 'Z');
  assert.equal(colLetter(27), 'AA');
  for (const n of [1, 5, 26, 27, 52, 100]) {
    assert.equal(parseColumnRef(colLetter(n)), n, `round-trip failed for ${n}`);
  }
});

test('parseColumnRef: an invalid reference is a loud, specific error, not a silent default', () => {
  assert.throws(() => parseColumnRef('1A'), /Invalid column reference/);
  assert.throws(() => parseColumnRef('$C'), /Invalid column reference/);
});

// ── Cell classification: the load-bearing correctness surface ───────────────────────────────

test('classifyCell: a formula cell with a CACHED result returns the RESULT, never the formula string', async () => {
  const wb = await loadFixtureWorkbook();
  const ws = wb.worksheets[0]!;
  const cell = ws.getCell('D3'); // B3*C3 -> 35
  const cr = classifyCell(cell);
  assert.equal(cr.kind, 'number');
  assert.equal(cr.raw, 35);
  assert.equal(cr.display, '35');
  assert.equal(cr.formula, 'B3*C3');
});

test('classifyCell: a formula cell with NO cached result is a LOUD, distinct kind — never rendered as empty or as a plausible zero', async () => {
  const wb = await loadFixtureWorkbook();
  const ws = wb.worksheets[0]!;
  const cell = ws.getCell('D4'); // formula B4*C4, no cached result
  const cr = classifyCell(cell);
  assert.equal(cr.kind, 'formula_no_cache');
  assert.equal(cr.raw, null);
  assert.notEqual(cr.display, '', 'must not look like an empty cell');
  assert.notEqual(cr.display, '0', 'must not look like a plausible zero');
  assert.match(cr.display, /no cached value/);
  assert.equal(cr.formula, 'B4*C4');
});

test('classifyCell: an Excel error cell (#DIV/0!) surfaces the error code, never blank or a number', async () => {
  const wb = await loadFixtureWorkbook();
  const ws = wb.worksheets[0]!;
  const cell = ws.getCell('D5');
  const cr = classifyCell(cell);
  assert.equal(cr.kind, 'error');
  assert.equal(cr.raw, '#DIV/0!');
  assert.equal(cr.display, '#DIV/0!');
});

test('classifyCell: EMPTY is distinct from ZERO', async () => {
  const wb = await loadFixtureWorkbook();
  const ws = wb.worksheets[0]!;
  const zero = classifyCell(ws.getCell('B4'));
  const empty = classifyCell(ws.getCell('C4'));
  assert.equal(zero.kind, 'number');
  assert.equal(zero.raw, 0);
  assert.equal(zero.display, '0');
  assert.equal(empty.kind, 'empty');
  assert.equal(empty.raw, null);
  assert.equal(empty.display, '');
  assert.notEqual(zero.display, empty.display, 'a zero must never render identically to a truly empty cell');
});

test('classifyCell: an Excel date serial is converted to a real date and clearly marked as one', async () => {
  const wb = await loadFixtureWorkbook();
  const ws = wb.worksheets[0]!;
  const cr = classifyCell(ws.getCell('E3'));
  assert.equal(cr.kind, 'date');
  assert.equal(cr.raw, '2022-12-31T00:00:00.000Z');
  assert.match(cr.display, /2022-12-31/);
  assert.match(cr.display, /\[date\]/, 'a date must say so, not look like a plain number');
});

test('classifyCell: raw ground-truth values for percent/currency-formatted cells are the UNFORMATTED number', async () => {
  const wb = await loadFixtureWorkbook();
  const ws = wb.worksheets[0]!;
  const pct = classifyCell(ws.getCell('F3'));
  const cur = classifyCell(ws.getCell('G3'));
  assert.equal(pct.kind, 'number');
  assert.equal(pct.raw, 0.15, 'a percent cell\'s ground truth is the fraction, not "15" or "15%"');
  assert.equal(cur.kind, 'number');
  assert.equal(cur.raw, 1234.5, 'a currency cell\'s ground truth is the plain number, not a formatted string');
});

test('classifyCell: a merged non-master cell resolves to the master\'s value and is flagged merged', async () => {
  const wb = await loadFixtureWorkbook();
  const ws = wb.worksheets[0]!;
  const master = classifyCell(ws.getCell('A1'));
  const slave = classifyCell(ws.getCell('C1')); // inside the A1:D1 merge, not the master
  assert.equal(master.display, '2022 EOY Hard Count Inventory Audit');
  assert.equal(slave.display, master.display, 'a merged cell must show the SAME value a human sees in Excel');
  assert.equal(slave.merged, true);
  assert.equal(master.merged, true, 'the master cell itself is also part of the merge');
});

test('classifyCell: a plain string/number/boolean cell round-trips exactly', async () => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('S');
  ws.getCell('A1').value = 'hello';
  ws.getCell('A2').value = 42;
  ws.getCell('A3').value = true;
  ws.getCell('A4').value = false;
  const buf = Buffer.from(await wb.xlsx.writeBuffer());
  const wb2 = await loadWorkbook(buf);
  const ws2 = wb2.worksheets[0]!;
  assert.deepEqual(classifyCell(ws2.getCell('A1')), { kind: 'string', raw: 'hello', display: 'hello' });
  assert.deepEqual(classifyCell(ws2.getCell('A2')), { kind: 'number', raw: 42, display: '42' });
  assert.deepEqual(classifyCell(ws2.getCell('A3')), { kind: 'boolean', raw: true, display: 'TRUE' });
  assert.deepEqual(classifyCell(ws2.getCell('A4')), { kind: 'boolean', raw: false, display: 'FALSE' });
});

// ── Sheet discovery (list mode) ──────────────────────────────────────────────────────────────

test('summarizeSheet: reports dimensions, merges, and a header-hunting preview without needing a target sheet', async () => {
  const wb = await loadFixtureWorkbook();
  const summary = summarizeSheet(wb.worksheets[0]!, 1, true);
  assert.equal(summary.name, 'Inventory');
  assert.equal(summary.index, 1);
  assert.equal(summary.merged_ranges.length, 1);
  assert.equal(summary.merged_ranges[0], 'A1:D1');
  assert.ok(summary.dimensions, 'dimensions must be populated');
  assert.ok(summary.preview, 'preview must be populated when includePreview=true');
  // Row 1 (index 0 of the preview) is the title, row 2 (index 1) is the REAL header — exactly the
  // "header row that is not row 1" case this tool must let a caller detect from the preview alone.
  assert.equal(summary.preview![1]![0], 'SKU');
  assert.equal(summary.preview![1]![3], 'EXT');
});

test('summarizeSheet: preview is omitted (not merely truncated) when includePreview=false', async () => {
  const wb = await loadFixtureWorkbook();
  const summary = summarizeSheet(wb.worksheets[0]!, 1, false);
  assert.equal(summary.preview, null);
  // Cheap facts must still be present even without a preview.
  assert.equal(summary.name, 'Inventory');
  assert.ok(summary.dimensions);
});

// ── Sheet resolution ──────────────────────────────────────────────────────────────────────────

test('resolveSheet: resolves by exact name, case-insensitive name, and 1-based index', async () => {
  const wb = await loadFixtureWorkbook();
  assert.equal(resolveSheet(wb, 'Inventory').name, 'Inventory');
  assert.equal(resolveSheet(wb, 'inventory').name, 'Inventory');
  assert.equal(resolveSheet(wb, 'INVENTORY').name, 'Inventory');
  assert.equal(resolveSheet(wb, 1).name, 'Inventory');
});

test('resolveSheet: an unknown sheet is a LOUD SheetNotFoundError listing what IS available — never an empty table', async () => {
  const wb = await loadFixtureWorkbook();
  assert.throws(
    () => resolveSheet(wb, 'NotASheet'),
    (e: unknown) => {
      assert.ok(e instanceof SheetNotFoundError);
      assert.match((e as Error).message, /NotASheet/);
      assert.match((e as Error).message, /Inventory/, 'must name the real sheets so the caller can retry correctly');
      return true;
    },
  );
  assert.throws(() => resolveSheet(wb, 99), SheetNotFoundError);
});

// ── Row-window reads ──────────────────────────────────────────────────────────────────────────

test('readRowWindow: a header row that is NOT row 1 is echoed on every page regardless of startRow', async () => {
  const wb = await loadFixtureWorkbook();
  const ws = wb.worksheets[0]!;
  const result = readRowWindow(ws, { startRow: 3, rowCount: 10, headerRow: 2 });
  assert.deepEqual(result.headers, ['SKU', 'Listed Inventory', 'Price Paid', 'EXT', 'Ship Date', 'Discount', 'Unit Cost']);
  assert.equal(result.header_row, 2);
  assert.equal(result.start_row, 3, 'the data window itself starts where asked, independent of the header row');
  assert.match(result.table, /SKU/, 'the header line must appear in the rendered table');
});

test('readRowWindow: real numeric values (including a cached formula result) reach the table — the actual regression this tool fixes', async () => {
  const wb = await loadFixtureWorkbook();
  const ws = wb.worksheets[0]!;
  const result = readRowWindow(ws, { startRow: 1, rowCount: 10, headerRow: 2 });
  // Row 3: SKU-1, 10, 3.5, 35 (the formula's CACHED result, not "B3*C3").
  assert.match(result.table, /\b10\b/);
  assert.match(result.table, /3\.5/);
  assert.match(result.table, /\b35\b/);
  assert.doesNotMatch(result.table, /B3\*C3/, 'the formula TEXT must never appear in place of its value');
  assert.equal(result.total_rows, 5);
});

test('readRowWindow: pagination arithmetic — total_rows and end_row always describe what was NOT seen too', async () => {
  const wb = await loadFixtureWorkbook();
  const ws = wb.worksheets[0]!;
  const page1 = readRowWindow(ws, { startRow: 1, rowCount: 2 });
  assert.equal(page1.start_row, 1);
  assert.equal(page1.end_row, 2);
  assert.equal(page1.returned_rows, 2);
  assert.equal(page1.total_rows, 5);
  const page2 = readRowWindow(ws, { startRow: page1.end_row + 1, rowCount: 2 });
  assert.equal(page2.start_row, 3);
  assert.equal(page2.end_row, 4);
});

test('readRowWindow: startCol/endCol narrows the window and reports truncation when the natural width exceeds the render cap', async () => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Wide');
  const wideCols = MAX_COLUMNS_RENDERED + 20;
  for (let c = 1; c <= wideCols; c++) ws.getCell(1, c).value = `v${c}`;
  const buf = Buffer.from(await wb.xlsx.writeBuffer());
  const wb2 = await loadWorkbook(buf);
  const ws2 = wb2.worksheets[0]!;

  const full = readRowWindow(ws2, { startRow: 1, rowCount: 1 });
  assert.equal(full.truncated_columns, true);
  assert.equal(full.end_col - full.start_col + 1, MAX_COLUMNS_RENDERED);

  const narrowed = readRowWindow(ws2, { startRow: 1, rowCount: 1, startCol: 5, endCol: 8 });
  assert.equal(narrowed.truncated_columns, false);
  assert.equal(narrowed.start_col, 5);
  assert.equal(narrowed.end_col, 8);
  assert.match(narrowed.table, /v5/);
  assert.doesNotMatch(narrowed.table, /\bv4\b/);
});

test('readRowWindow: a formula-with-no-cached-value and an error cell both produce a WARNING naming the exact row/column', async () => {
  const wb = await loadFixtureWorkbook();
  const ws = wb.worksheets[0]!;
  const result = readRowWindow(ws, { startRow: 1, rowCount: 10 });
  assert.ok(result.warnings.some((w) => /Row 4, column D/.test(w) && /no cached value/.test(w)));
  assert.ok(result.warnings.some((w) => /Row 5, column D/.test(w) && /#DIV\/0!/.test(w)));
});

test('readRowWindow: currency/percent number formats are captured per column as context, never applied to the raw value', async () => {
  const wb = await loadFixtureWorkbook();
  const ws = wb.worksheets[0]!;
  const result = readRowWindow(ws, { startRow: 1, rowCount: 10 });
  assert.equal(result.column_formats['F'], '0.00%');
  assert.equal(result.column_formats['G'], '$#,##0.00');
  assert.ok(!('A' in result.column_formats), 'a plain-text column must not get a spurious format entry');
});

test('readRowWindow: output size cap truncates HONESTLY — fewer rows are reported, not a silently short table', async () => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Big');
  const longText = 'x'.repeat(500);
  const rows = 400;
  for (let r = 1; r <= rows; r++) {
    for (let c = 1; c <= 5; c++) ws.getCell(r, c).value = `${longText}-${r}-${c}`;
  }
  const buf = Buffer.from(await wb.xlsx.writeBuffer());
  const wb2 = await loadWorkbook(buf);
  const ws2 = wb2.worksheets[0]!;

  const result = readRowWindow(ws2, { startRow: 1, rowCount: rows });
  assert.equal(result.output_truncated, true);
  assert.ok(result.returned_rows < rows, 'must not silently claim to have returned everything requested');
  assert.ok(result.table.length <= TABLE_CHAR_CAP + 1000, 'the table text must stay bounded');
  assert.ok(
    result.warnings.some((w) => /truncated/i.test(w) && /re-call/i.test(w)),
    'the truncation must be a loud, actionable warning, not a silent gap',
  );
  // Re-calling from where it left off must make forward progress (never returns 0 new rows for a
  // genuinely unread remainder).
  const nextPage = readRowWindow(ws2, { startRow: result.end_row + 1, rowCount: rows });
  assert.ok(nextPage.returned_rows > 0);
});

// ── Workbook parsing ──────────────────────────────────────────────────────────────────────────

test('loadWorkbook: a well-formed fixture parses cleanly', async () => {
  const wb = await loadFixtureWorkbook();
  assert.equal(wb.worksheets.length, 1);
  assert.equal(wb.worksheets[0]!.name, 'Inventory');
});

test('loadWorkbook: garbage bytes are a LOUD WorkbookParseError, never an empty/blank workbook', async () => {
  await assert.rejects(
    () => loadWorkbook(Buffer.from('this is not a zip file at all, just plain text bytes')),
    (e: unknown) => {
      assert.ok(e instanceof WorkbookParseError);
      assert.ok((e as Error).message.length > 0);
      return true;
    },
  );
});

test('loadWorkbook: a truncated (corrupted) real workbook is also a loud parse error', async () => {
  const full = await buildFixtureBuffer();
  const truncated = full.subarray(0, Math.floor(full.length / 2));
  await assert.rejects(() => loadWorkbook(truncated), WorkbookParseError);
});

// ── Ring boundary (mirrors get-document.test.ts — same gate, same rooms) ───────────────────────

test('RING: cfo (and the exec ring) may reach the finance indexes this tool serves; cto/developer/external may NOT', () => {
  for (const index of FINANCE_DOC_INDEXES) {
    assert.equal(isLaneAllowed(index, 'cfo'), true, `cfo must be allowed on ${index}`);
    assert.equal(isLaneAllowed(index, 'exec'), true, `exec must be allowed on ${index}`);
    assert.equal(isLaneAllowed(index, 'cto'), false, `cto must be refused on ${index}`);
    assert.equal(isLaneAllowed(index, 'developer'), false, `developer must be refused on ${index}`);
    assert.equal(isLaneAllowed(index, ''), false, 'unknown/external caller must be refused');
  }
});

// Sanity pin: MAX_PREVIEW_SHEETS is imported and used above; this keeps the export honest against
// an accidental future removal of the symbol (a pure existence/type check, no behavior asserted).
test('MAX_PREVIEW_SHEETS is a positive integer', () => {
  assert.ok(Number.isInteger(MAX_PREVIEW_SHEETS) && MAX_PREVIEW_SHEETS > 0);
});
