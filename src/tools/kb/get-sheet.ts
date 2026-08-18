/**
 * kb_get_sheet — ring-gated NUMERIC-CELL retrieval from an XLSX workbook in the finance dataroom.
 *
 * WHY (CFO escalation, 2026-08-17): kb_get_document already lets the CFO read a document's TEXT, but
 * for a spreadsheet that text comes from the doc-indexer's `_TEXT/` sidecar, which carries only the
 * text LAYER extracted from the file (labels, headers, sheet names) — every NUMERIC CELL VALUE is
 * absent, because a text extractor has nothing to do with a cell grid. On "#5.2 HA incomplete.xlsx"
 * that meant ~130 SKU rows of labels with no quantities, no unit costs, no extensions, blocking an
 * inventory restatement over a live $375.00 variance. For an audit reconstruction the numbers ARE the
 * document — this tool reads the workbook's REAL BYTES (never the text sidecar) and returns actual
 * cell values: formula CACHED results (not the formula string), Excel date serials converted to real
 * dates, currency/percent format context, and a hard distinction between an empty cell and a zero.
 *
 * NEW TOOL, not a mode on kb_get_document, because the two are shaped for genuinely different callers:
 *  - kb_get_document's whole contract is a linear TEXT stream, paginated by CHARACTERS, with a
 *    total_chars/total_lines/sha256 completeness proof. A spreadsheet is a 2-D grid with sheets,
 *    columns, and a header row that is frequently NOT row 1 — cramming that into a char-paginated
 *    text contract would either break kb_get_document's existing completeness invariant for its
 *    real callers or require a parallel, mode-switched output shape bolted onto an already-long
 *    tool description. A dedicated tool gets a small, self-describing Zod contract instead.
 *  - kb_get_document treats any binary blob (its `looksBinary` check) as something to redirect to the
 *    `_TEXT/` sidecar. That redirect is EXACTLY the bug this tool exists to route around — an XLSX
 *    must never be served from its text sidecar here, it must be parsed as a real workbook.
 *  - The actual CFO workflow is two distinct calls with two distinct shapes: (1) discover — which
 *    sheets exist, how big are they, where does the real header sit (a cheap, small call with no row
 *    data); (2) read — a bounded row/column window off ONE named sheet once the caller knows where to
 *    look. Modeling that as "pass `sheet` or don't" on one tool matches how the workflow actually
 *    unfolds; a `mode` flag on a text-retrieval tool would not.
 *
 * SHARED PLUMBING (never re-implemented): ring gate (isLaneAllowed / INDEX_LANES, imported from
 * search-privileged.ts — the single source of truth), path-dialect normalisation (toContainerRelative,
 * imported from get-document.ts — the exact fix for the "10 of 10 attempts failed" defect class),
 * path safety (isSafeBlobPath), and the raw blob fetch (fetchBlobRaw, the SAME proven Azure SharedKey
 * signer legal/blob-store.ts already uses for kb_get_document). This tool ADDS one more path
 * normalisation step on top (resolveOriginalPath): a caller who copies the `_TEXT/…xlsx.txt` sidecar
 * path straight out of a kb_search_privileged hit — the natural, expected thing to do — is resolved
 * back to the real workbook path rather than failing, closing the same "path copied verbatim from a
 * search hit" defect class get-document.ts's toContainerRelative already closed once.
 *
 * FAILURE DISCIPLINE (the load-bearing requirement): a parse failure, an unsupported format, a missing
 * sheet, or an output-size truncation must never render as a plausible-looking empty or short table —
 * every one of those returns `found:false` (or `output_truncated:true`) plus a specific `error` code
 * and a summary an analyst cannot mistake for "this sheet has no data". A formula cell with no cached
 * result, and an Excel error cell (#REF!, #DIV/0!, …), are surfaced explicitly in `warnings` and in the
 * cell text itself — never silently rendered as blank.
 *
 * PARSER: `exceljs` (MIT). No spreadsheet parser existed in this repo's dependencies before this tool
 * (checked package.json first) — this is therefore a NEW dependency and is FLAGGED for the repo's
 * supply-chain review/cooldown, not assumed pre-approved. Chosen over the official `xlsx` (SheetJS)
 * npm package, which is capped at 0.18.5 with known CVEs (SheetJS only publishes patched 0.20.x builds
 * via their own CDN, not npm) and over `@e965/xlsx` (a lighter, zero-dependency but SINGLE-MAINTAINER
 * unofficial republish of SheetJS's CDN build — a different, and for a finance-critical read path less
 * acceptable, trust concern). `exceljs` is officially published under its own name, MIT-licensed, and
 * by far the most widely adopted pure-JS reader for this exact "give me real cell values, cached
 * formula results, and merge/format context" use case (~51M npm downloads/month at the time of this
 * change, vs ~3.3M for `@e965/xlsx`). Read-only: only `workbook.xlsx.load()` is ever called, never any
 * write/output API.
 */
import ExcelJS from 'exceljs';
import crypto from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { loadEnv } from '../../config/env.js';
import { fetchBlobRaw } from '../../legal/blob-store.js';
import { isLaneAllowed } from './search-privileged.js';
import { FINANCE_DOC_INDEXES, isSafeBlobPath, toContainerRelative, TEXT_PREFIX } from './get-document.js';

const CONTAINER = 'cfo-source-docs';

/** Same cap as kb_get_document — a runaway/binary blob must not OOM the gateway. */
const MAX_BYTES = 50 * 1024 * 1024;

export const DEFAULT_ROW_COUNT = 100;
export const MAX_ROW_COUNT = 500;
/** Column-width render cap per call, independent of MAX_ROW_COUNT — a pathologically wide sheet must
 *  not blow up the response even at a small row count. */
export const MAX_COLUMNS_RENDERED = 60;
/** Hard character cap on the rendered table text, belt-and-suspenders under the row/column caps above
 *  (a wide MAX_COLUMNS_RENDERED window of long text cells could still be large). Mirrors
 *  get-document.ts's PAGE_CHARS discipline: bounded, and the caller is told when it bit. */
export const TABLE_CHAR_CAP = 120_000;
/** In list (discovery) mode: how many leading rows of preview to compute per sheet, and how many
 *  sheets get a preview at all (a workbook with dozens of sheets stays cheap to list). */
const PREVIEW_ROWS = 5;
const PREVIEW_COLS = 20;
export const MAX_PREVIEW_SHEETS = 15;

export const SUPPORTED_EXTENSIONS = ['.xlsx', '.xlsm'] as const;

// ── Path resolution ────────────────────────────────────────────────────────────────────────────

/**
 * Inverse of get-document.ts's sidecarPathFor(). A path copied verbatim out of a kb_search_privileged
 * hit for an XLSX carries the `_TEXT/<path>.txt` sidecar form (the extracted-text layer, not the
 * workbook). This tool needs the REAL bytes, so recover the original path when the wrapper is exact —
 * never a positional guess, only an exact `_TEXT/` prefix + `.txt` suffix strip, mirroring
 * toContainerRelative's "exact-prefix, not positional" discipline.
 */
export function resolveOriginalPath(containerRelativePath: string): string {
  if (containerRelativePath.startsWith(TEXT_PREFIX) && containerRelativePath.endsWith('.txt')) {
    return containerRelativePath.slice(TEXT_PREFIX.length, -'.txt'.length);
  }
  return containerRelativePath;
}

export function hasSupportedSpreadsheetExtension(path: string): boolean {
  const lower = path.toLowerCase();
  return (SUPPORTED_EXTENSIONS as readonly string[]).some((ext) => lower.endsWith(ext));
}

/** Excel column letters (A, B, …, Z, AA, …) -> 1-based number. */
export function parseColumnRef(v: number | string): number {
  if (typeof v === 'number') return v;
  const s = v.trim().toUpperCase();
  if (!/^[A-Z]+$/.test(s)) {
    throw new Error(
      `Invalid column reference "${v}": expected a 1-based number or Excel column letters (A, B, ..., Z, AA, ...).`,
    );
  }
  let n = 0;
  for (const ch of s) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

/** 1-based number -> Excel column letters. Inverse of parseColumnRef. */
export function colLetter(n: number): string {
  let s = '';
  let x = n;
  while (x > 0) {
    const rem = (x - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    x = Math.floor((x - 1) / 26);
  }
  return s || 'A';
}

// ── Cell classification (the load-bearing correctness logic) ─────────────────────────────────────

export type CellKind = 'empty' | 'number' | 'string' | 'boolean' | 'date' | 'error' | 'formula_no_cache' | 'other';

export interface CellRender {
  kind: CellKind;
  /** Ground-truth value: a real number/string/boolean/ISO-date-string, or null for empty/unrepresentable.
   *  Never a display-formatted string (currency/percent formatting lives in `display` + column_formats). */
  raw: number | string | boolean | null;
  /** Compact text for the rendered table. */
  display: string;
  /** Set when the cell is (or resolves through) a formula — the formula text, not its value. */
  formula?: string;
  /** Set when this cell's value is inherited from a merged range's master cell, not entered here. */
  merged?: boolean;
}

function isMidnightUtc(d: Date): boolean {
  return (
    d.getUTCHours() === 0 && d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0 && d.getUTCMilliseconds() === 0
  );
}

function formatDate(d: Date): { iso: string; display: string } {
  const iso = d.toISOString();
  const pad = (n: number) => String(n).padStart(2, '0');
  const ymd = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  const display = isMidnightUtc(d) ? `${ymd} [date]` : `${iso} [date]`;
  return { iso, display };
}

function classifyPrimitive(v: number | string | boolean): CellRender {
  if (typeof v === 'boolean') return { kind: 'boolean', raw: v, display: v ? 'TRUE' : 'FALSE' };
  if (typeof v === 'number') return { kind: 'number', raw: v, display: String(v) };
  return { kind: 'string', raw: v, display: v };
}

/**
 * Classifies a cell's REAL value — formulas resolve to their CACHED result (never the formula string),
 * Excel errors surface as their error code (never as empty), dates convert from the serial to a real
 * calendar date, and a genuinely empty cell is distinct from a cell holding the number zero. Inspects
 * the raw `cell.value` SHAPE directly rather than trusting `cell.effectiveType` alone — exceljs's
 * effectiveType collapses a formula cell whose cached result is itself an error object down to
 * "Null" (verified empirically; see get-sheet.test.ts), which would silently misreport a #DIV/0! cell
 * as merely empty. `cell.value` already resolves a merged non-master cell to its master's value
 * (exceljs's own getter), so no separate merge-resolution step is needed here — this function only
 * flags `merged: true` via `cell.isMerged` so the caller knows the value is shared, not re-entered.
 */
export function classifyCell(cell: ExcelJS.Cell): CellRender {
  const raw = cell.value as unknown;
  let base: CellRender;

  if (raw && typeof raw === 'object' && 'formula' in (raw as Record<string, unknown>)) {
    const fv = raw as ExcelJS.CellFormulaValue & Partial<ExcelJS.CellSharedFormulaValue>;
    const formula = fv.formula || fv.sharedFormula || '(shared formula)';
    const hasResult = 'result' in fv && fv.result !== undefined;
    if (!hasResult) {
      base = {
        kind: 'formula_no_cache',
        raw: null,
        display: `[formula, no cached value: ${formula}]`,
        formula,
      };
    } else {
      const result = fv.result;
      if (result && typeof result === 'object' && 'error' in result) {
        const err = (result as ExcelJS.CellErrorValue).error;
        base = { kind: 'error', raw: err, display: err, formula };
      } else if (result instanceof Date) {
        const d = formatDate(result);
        base = { kind: 'date', raw: d.iso, display: d.display, formula };
      } else if (typeof result === 'object') {
        // Defensive: an unexpected cached-result shape (e.g. rich text). Never silently blank it.
        const text = cell.text || JSON.stringify(result);
        base = { kind: 'other', raw: text, display: text, formula };
      } else {
        base = { ...classifyPrimitive(result as number | string | boolean), formula };
      }
    }
  } else if (raw && typeof raw === 'object' && 'error' in (raw as Record<string, unknown>)) {
    const err = (raw as ExcelJS.CellErrorValue).error;
    base = { kind: 'error', raw: err, display: err };
  } else if (raw === null || raw === undefined) {
    base = { kind: 'empty', raw: null, display: '' };
  } else if (raw instanceof Date) {
    const d = formatDate(raw);
    base = { kind: 'date', raw: d.iso, display: d.display };
  } else if (typeof raw === 'object') {
    // Rich text / hyperlink / other object cell values: fall back to exceljs's own text rendering
    // rather than showing "[object Object]" or dropping the value.
    const text = cell.text || '(unrepresentable value)';
    base = { kind: 'other', raw: text, display: text };
  } else {
    base = classifyPrimitive(raw as number | string | boolean);
  }

  if (cell.isMerged) base.merged = true;
  return base;
}

// ── Sheet discovery ────────────────────────────────────────────────────────────────────────────

export interface SheetSummary {
  name: string;
  /** 1-based position in workbook.worksheets — the SAME numbering resolveSheet()'s numeric selector uses. */
  index: number;
  state: string;
  row_count: number;
  actual_row_count: number;
  column_count: number;
  dimensions: string | null;
  merged_ranges: string[];
  /** First few rows/cols rendered as text, so a caller can spot the real header row before pulling
   *  data. Null when this workbook has more than MAX_PREVIEW_SHEETS sheets and this one was skipped
   *  to keep discovery cheap (name/dimensions are still always returned). */
  preview: string[][] | null;
}

export function summarizeSheet(ws: ExcelJS.Worksheet, index: number, includePreview: boolean): SheetSummary {
  let preview: string[][] | null = null;
  if (includePreview) {
    const previewRowCount = Math.min(PREVIEW_ROWS, ws.rowCount);
    const cols = Math.min(PREVIEW_COLS, Math.max(ws.columnCount, 1));
    preview = [];
    for (let r = 1; r <= previewRowCount; r++) {
      const row = ws.getRow(r);
      const line: string[] = [];
      for (let c = 1; c <= cols; c++) line.push(classifyCell(row.getCell(c)).display);
      preview.push(line);
    }
  }
  return {
    name: ws.name,
    index,
    state: ws.state,
    row_count: ws.rowCount,
    actual_row_count: ws.actualRowCount,
    column_count: ws.columnCount,
    dimensions: ws.dimensions ? ws.dimensions.range : null,
    merged_ranges: [...(ws.model.merges ?? [])],
    preview,
  };
}

export class SheetNotFoundError extends Error {
  constructor(
    public readonly requested: string | number,
    public readonly available: string[],
  ) {
    super(
      `Sheet "${requested}" not found. Available sheets: ${
        available.length ? available.join(', ') : '(this workbook has no sheets)'
      }`,
    );
    this.name = 'SheetNotFoundError';
  }
}

/** Resolves a sheet by exact name, then case-insensitive name, then 1-based index. Throws
 *  SheetNotFoundError (never returns undefined) so a bad sheet selector is always a loud, specific
 *  failure — never a call site that quietly falls through to an empty table. */
export function resolveSheet(workbook: ExcelJS.Workbook, selector: string | number): ExcelJS.Worksheet {
  const sheets = workbook.worksheets;
  const available = sheets.map((s) => s.name);
  if (typeof selector === 'number') {
    const ws = sheets[selector - 1];
    if (!ws) throw new SheetNotFoundError(selector, available);
    return ws;
  }
  const exact = sheets.find((s) => s.name === selector);
  if (exact) return exact;
  const lower = selector.toLowerCase();
  const ci = sheets.find((s) => s.name.toLowerCase() === lower);
  if (ci) return ci;
  throw new SheetNotFoundError(selector, available);
}

// ── Row-window read ────────────────────────────────────────────────────────────────────────────

export interface RowWindowResult {
  sheet: string;
  header_row: number | null;
  headers: string[] | null;
  start_row: number;
  end_row: number;
  returned_rows: number;
  total_rows: number;
  start_col: number;
  end_col: number;
  total_cols: number;
  truncated_columns: boolean;
  output_truncated: boolean;
  /** Column letter -> a representative non-default number-format string seen in this window (e.g.
   *  "0.00%" or "$#,##0.00"). Cell values themselves are always the raw, unformatted number — this is
   *  context for interpreting them (0.15 in a "0.00%" column means 15%), never applied to `raw`. */
  column_formats: Record<string, string>;
  table: string;
  warnings: string[];
}

export function readRowWindow(
  ws: ExcelJS.Worksheet,
  opts: { startRow: number; rowCount: number; headerRow?: number; startCol?: number; endCol?: number },
): RowWindowResult {
  const totalRows = ws.rowCount;
  const totalCols = Math.max(ws.columnCount, 1);
  let startCol = Math.max(1, Math.min(opts.startCol ?? 1, totalCols));
  let endCol = Math.max(startCol, Math.min(opts.endCol ?? totalCols, totalCols));
  let truncatedColumns = false;
  if (endCol - startCol + 1 > MAX_COLUMNS_RENDERED) {
    endCol = startCol + MAX_COLUMNS_RENDERED - 1;
    truncatedColumns = true;
  }

  const warnings: string[] = [];
  const columnFormats: Record<string, string> = {};
  const noteFormat = (c: number, numFmt: string | undefined) => {
    if (numFmt && numFmt !== 'General') {
      const letter = colLetter(c);
      if (!(letter in columnFormats)) columnFormats[letter] = numFmt;
    }
  };

  const colRefLine = ['row', ...Array.from({ length: endCol - startCol + 1 }, (_, i) => colLetter(startCol + i))].join(' | ');
  const lines: string[] = [colRefLine];
  let sizeBudget = TABLE_CHAR_CAP - colRefLine.length;

  let headers: string[] | null = null;
  if (opts.headerRow != null) {
    const hRow = ws.getRow(opts.headerRow);
    headers = [];
    const cells: string[] = ['(header)'];
    for (let c = startCol; c <= endCol; c++) {
      const cell = hRow.getCell(c);
      const cr = classifyCell(cell);
      noteFormat(c, cell.numFmt);
      const text = cr.display || `col${colLetter(c)}`;
      headers.push(text);
      cells.push(text);
      if (cr.kind === 'formula_no_cache') {
        warnings.push(`Header row ${opts.headerRow}, column ${colLetter(c)}: formula with no cached value.`);
      }
    }
    const line = cells.join(' | ');
    lines.push(line);
    sizeBudget -= line.length;
  }

  const startRow = Math.max(1, Math.min(opts.startRow, Math.max(totalRows, 1)));
  const lastWanted = Math.min(totalRows, startRow + opts.rowCount - 1);
  let returned = 0;
  let outputTruncated = false;
  let lastEmittedRow = startRow - 1;
  for (let r = startRow; r <= lastWanted; r++) {
    const row = ws.getRow(r);
    const cells: string[] = [String(r)];
    for (let c = startCol; c <= endCol; c++) {
      const cell = row.getCell(c);
      const cr = classifyCell(cell);
      noteFormat(c, cell.numFmt);
      if (cr.kind === 'formula_no_cache') {
        warnings.push(
          `Row ${r}, column ${colLetter(c)}: formula "${cr.formula}" has no cached value (the workbook was ` +
            `likely saved without recalculation) — returning nothing rather than guessing at a number.`,
        );
      }
      if (cr.kind === 'error') {
        warnings.push(`Row ${r}, column ${colLetter(c)}: cell holds an Excel error (${cr.display}), not a value.`);
      }
      cells.push(cr.display);
    }
    const line = cells.join(' | ');
    if (line.length + 1 > sizeBudget) {
      outputTruncated = true;
      break;
    }
    lines.push(line);
    sizeBudget -= line.length + 1;
    lastEmittedRow = r;
    returned++;
  }

  if (outputTruncated) {
    warnings.push(
      `OUTPUT TRUNCATED at the ${TABLE_CHAR_CAP}-char size cap: returned rows ${startRow}-${lastEmittedRow} of the ` +
        `requested ${startRow}-${lastWanted}. This is NOT the whole requested window — re-call with ` +
        `startRow=${lastEmittedRow + 1} to continue, or narrow startCol/endCol.`,
    );
  }

  return {
    sheet: ws.name,
    header_row: opts.headerRow ?? null,
    headers,
    start_row: startRow,
    end_row: lastEmittedRow,
    returned_rows: returned,
    total_rows: totalRows,
    start_col: startCol,
    end_col: endCol,
    total_cols: totalCols,
    truncated_columns: truncatedColumns,
    output_truncated: outputTruncated,
    column_formats: columnFormats,
    table: lines.join('\n'),
    warnings,
  };
}

// ── Workbook load ──────────────────────────────────────────────────────────────────────────────

export class WorkbookParseError extends Error {
  constructor(public readonly cause: unknown) {
    super(`Failed to parse workbook: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'WorkbookParseError';
  }
}

/** Thin, testable wrapper: real bytes in, a loaded workbook out, or a specific WorkbookParseError —
 *  never a silently-empty workbook. */
export async function loadWorkbook(buf: Buffer): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook();
  try {
    // exceljs's index.d.ts is a MODULE (it has top-level `export`s), so its own top-of-file
    // `declare interface Buffer extends ArrayBuffer {}` — a lightweight polyfill so exceljs can
    // type-check without a hard @types/node dependency — is a MODULE-SCOPED local type, not a global
    // ambient one. `load()`'s `buffer: Buffer` parameter therefore refers to THAT local, non-generic,
    // ArrayBuffer-shaped type, a structurally different type from the real (generic, Uint8Array-based)
    // Node `Buffer` this function's own signature uses — not a real runtime mismatch, a genuine Node
    // Buffer is exactly what `.load()` expects and consumes at runtime. `Parameters<...>` pulls the
    // exact type `load()` declares without needing to name exceljs's private type directly, and the
    // unknown-mediated cast documents that this is a deliberate library-boundary workaround.
    await workbook.xlsx.load(buf as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  } catch (e) {
    throw new WorkbookParseError(e);
  }
  return workbook;
}

// ── Tool registration ─────────────────────────────────────────────────────────────────────────

export function registerKbGetSheet(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(
    server,
    {
      name: 'kb_get_sheet',
      category: 'read',
      annotations: {
        title: 'Read real cell values (not text) from an XLSX workbook in the finance dataroom',
        description:
          'Ring-gated XLSX reader over the finance dataroom (account otchealthcfodata/cfo-source-docs). ' +
          'Reads the ACTUAL WORKBOOK BYTES, never the _TEXT/ text-extraction sidecar, so unlike ' +
          'kb_get_document it returns real numeric cell values: formula CACHED results (never the ' +
          'formula string), Excel dates converted from their serial, and empty cells distinct from ' +
          'zero. WORKFLOW: (1) call with just index+path to LIST every sheet (name, dimensions, a ' +
          'short preview) without pulling any row data — use this to find the right sheet and spot ' +
          'the real header row, which is often not row 1; (2) call again with `sheet` set to read a ' +
          'bounded row window, optionally with `headerRow` (echoed on every page) and startCol/endCol ' +
          'to narrow a wide sheet. Paginated by rows (startRow/rowCount); every response reports ' +
          'total_rows and end_row so you always know what you have not seen yet. Accepts a path copied ' +
          'straight from a kb_search_privileged hit, including its _TEXT/….xlsx.txt sidecar form — this ' +
          'tool resolves that back to the real workbook automatically. Only .xlsx/.xlsm are supported; ' +
          'legacy .xls or any non-spreadsheet format is refused with a clear error, never an empty ' +
          'table. Ring-gated to the executive ring exactly like kb_get_document / kb_search_privileged; ' +
          'MNPI, internal-only, read-only.',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputShape: {
        index: z.enum(FINANCE_DOC_INDEXES).describe('Which finance index namespace (both map to the same physical store).'),
        path: z.string().min(1).describe(
          'Blob path within the store, e.g. "mail-archive-attachments/.../#5.2 HA incomplete.xlsx". A ' +
            '_TEXT/....xlsx.txt sidecar path (copied from a search hit) is also accepted and resolved ' +
            'back to the real workbook automatically.',
        ),
        sheet: z
          .union([z.string().min(1), z.number().int().min(1)])
          .optional()
          .describe(
            'Sheet name (case-insensitive) or 1-based sheet index. OMIT to LIST every sheet with ' +
              'dimensions + a short preview instead of reading row data.',
          ),
        startRow: z.number().int().min(1).optional().describe('1-based first row to return. Default 1. Ignored when `sheet` is omitted.'),
        rowCount: z
          .number()
          .int()
          .min(1)
          .max(MAX_ROW_COUNT)
          .optional()
          .describe(`Rows to return (default ${DEFAULT_ROW_COUNT}, max ${MAX_ROW_COUNT}). Ignored when \`sheet\` is omitted.`),
        headerRow: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe(
            '1-based row holding column headers, when it is NOT row 1 (e.g. a title row sits above it). ' +
              'Always echoed at the top of the table regardless of startRow. Ignored when `sheet` is omitted.',
          ),
        startCol: z
          .union([z.number().int().min(1), z.string().min(1)])
          .optional()
          .describe('First column to return: a 1-based number or an Excel letter ("C"). Default 1 (A).'),
        endCol: z
          .union([z.number().int().min(1), z.string().min(1)])
          .optional()
          .describe(`Last column to return (number or Excel letter). Default: the sheet's full width, capped at ${MAX_COLUMNS_RENDERED} columns per call.`),
      },
      outputShape: {
        index: z.string(),
        path: z.string(),
        found: z.boolean(),
        mode: z.enum(['list', 'rows']),
        sheet_count: z.number().nullable(),
        sheets: z
          .array(
            z.object({
              name: z.string(),
              index: z.number(),
              state: z.string(),
              row_count: z.number(),
              actual_row_count: z.number(),
              column_count: z.number(),
              dimensions: z.string().nullable(),
              merged_ranges: z.array(z.string()),
              preview: z.array(z.array(z.string())).nullable(),
            }),
          )
          .nullable(),
        sheet: z.string().nullable(),
        header_row: z.number().nullable(),
        headers: z.array(z.string()).nullable(),
        start_row: z.number().nullable(),
        end_row: z.number().nullable(),
        returned_rows: z.number().nullable(),
        total_rows: z.number().nullable(),
        start_col: z.number().nullable(),
        end_col: z.number().nullable(),
        total_cols: z.number().nullable(),
        truncated_columns: z.boolean().nullable(),
        output_truncated: z.boolean().nullable(),
        column_formats: z.record(z.string(), z.string()).nullable(),
        table: z.string().nullable(),
        warnings: z.array(z.string()),
        sha256: z.string().nullable(),
        error: z.string().optional(),
      },
      handler: async (input, ctx) => {
        const index = input.index;
        const rawPath = input.path.trim();
        const caller = ctx.callerAgent || '';
        const empty = {
          index,
          path: rawPath,
          found: false,
          mode: 'list' as const,
          sheet_count: null,
          sheets: null,
          sheet: null,
          header_row: null,
          headers: null,
          start_row: null,
          end_row: null,
          returned_rows: null,
          total_rows: null,
          start_col: null,
          end_col: null,
          total_cols: null,
          truncated_columns: null,
          output_truncated: null,
          column_formats: null,
          table: null,
          warnings: [] as string[],
          sha256: null,
        };

        if (!isLaneAllowed(index, caller)) {
          return {
            data: { ...empty, error: 'forbidden_ring' },
            summary: `Refused: "${index}" is ring-gated (MNPI). Your identity: ${caller || '(none)'}. Privileged finance documents are never served outside the executive ring.`,
          };
        }
        if (!isSafeBlobPath(rawPath)) {
          return { data: { ...empty, error: 'invalid_path' }, summary: 'Refused: path must be container-relative with no traversal.' };
        }
        const env = loadEnv();
        if (!env.AZURE_CFO_STORAGE_KEY) {
          return { data: { ...empty, error: 'unconfigured' }, summary: 'Finance store not configured (AZURE_CFO_STORAGE_KEY unset).' };
        }

        // Same path-dialect normalisation kb_get_document uses (a search hit's fully-qualified
        // <account>/<container>/<path> form), PLUS this tool's own sidecar-recovery step.
        const containerRelative = toContainerRelative(rawPath, env.AZURE_CFO_STORAGE_ACCOUNT, CONTAINER);
        const relPath = resolveOriginalPath(containerRelative);

        if (!hasSupportedSpreadsheetExtension(relPath)) {
          return {
            data: { ...empty, error: 'unsupported_format' },
            summary:
              `"${relPath}" does not have a supported spreadsheet extension (${SUPPORTED_EXTENSIONS.join(', ')}). ` +
              `Legacy .xls, .csv, .pdf, and every other format are not readable by this tool — use kb_get_document ` +
              `for a text extraction instead, or ask the CTO for an .xlsx conversion.`,
          };
        }

        let res;
        try {
          res = await fetchBlobRaw(env.AZURE_CFO_STORAGE_ACCOUNT, env.AZURE_CFO_STORAGE_KEY, CONTAINER, relPath);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return { data: { ...empty, error: msg }, summary: `Fetch failed: ${msg}` };
        }
        if (!res.found || !res.buf) {
          return { data: empty, summary: `No blob at ${CONTAINER}/${relPath}.` };
        }
        if (res.buf.length > MAX_BYTES) {
          return {
            data: { ...empty, error: 'too_large' },
            summary: `Blob is ${res.buf.length} bytes (> ${MAX_BYTES} cap). Ask the CTO for a chunked export of this file.`,
          };
        }

        const sha256 = crypto.createHash('sha256').update(res.buf).digest('hex');

        let workbook: ExcelJS.Workbook;
        try {
          workbook = await loadWorkbook(res.buf);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return {
            data: { ...empty, error: 'parse_error', sha256 },
            summary:
              `${CONTAINER}/${relPath} could not be parsed as a workbook (${msg}). This is a genuine parse ` +
              `failure — the file may be corrupt, truncated, or not actually an OOXML .xlsx/.xlsm despite its ` +
              `extension. Returning nothing rather than an empty table.`,
          };
        }

        // ── LIST mode: no `sheet` given -> cheap discovery, zero row data. ──────────────────────
        if (input.sheet === undefined) {
          const includePreview = workbook.worksheets.length <= MAX_PREVIEW_SHEETS;
          const sheets = workbook.worksheets.map((ws, i) => summarizeSheet(ws, i + 1, includePreview));
          return {
            data: {
              ...empty,
              found: true,
              mode: 'list',
              sheet_count: sheets.length,
              sheets,
              sha256,
              warnings: includePreview
                ? []
                : [`${sheets.length} sheets exceeds the preview cap (${MAX_PREVIEW_SHEETS}); names/dimensions are complete, previews were skipped.`],
            },
            summary:
              `${CONTAINER}/${relPath}: ${sheets.length} sheet(s) — ${sheets.map((s) => `"${s.name}" (${s.dimensions ?? 'empty'}, ${s.actual_row_count} data rows)`).join('; ')}. ` +
              `Call again with sheet="<name>" to read row data. sha256=${sha256.slice(0, 12)}… (lane=${caller}).`,
          };
        }

        // ── ROWS mode: a specific sheet was requested. ──────────────────────────────────────────
        let ws: ExcelJS.Worksheet;
        try {
          ws = resolveSheet(workbook, input.sheet);
        } catch (e) {
          if (e instanceof SheetNotFoundError) {
            return {
              data: { ...empty, error: 'sheet_not_found', sha256 },
              summary: e.message,
            };
          }
          throw e;
        }

        let startCol: number | undefined;
        let endCol: number | undefined;
        try {
          if (input.startCol !== undefined) startCol = parseColumnRef(input.startCol);
          if (input.endCol !== undefined) endCol = parseColumnRef(input.endCol);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return { data: { ...empty, error: 'invalid_column', sha256 }, summary: msg };
        }

        const result = readRowWindow(ws, {
          startRow: input.startRow ?? 1,
          rowCount: input.rowCount ?? DEFAULT_ROW_COUNT,
          headerRow: input.headerRow,
          startCol,
          endCol,
        });

        return {
          data: {
            index,
            path: relPath,
            found: true,
            mode: 'rows' as const,
            sheet_count: workbook.worksheets.length,
            sheets: null,
            sheet: result.sheet,
            header_row: result.header_row,
            headers: result.headers,
            start_row: result.start_row,
            end_row: result.end_row,
            returned_rows: result.returned_rows,
            total_rows: result.total_rows,
            start_col: result.start_col,
            end_col: result.end_col,
            total_cols: result.total_cols,
            truncated_columns: result.truncated_columns,
            output_truncated: result.output_truncated,
            column_formats: result.column_formats,
            table: result.table,
            warnings: result.warnings,
            sha256,
          },
          summary:
            `${CONTAINER}/${relPath} sheet "${result.sheet}": rows ${result.start_row}-${result.end_row} of ` +
            `${result.total_rows} total, columns ${colLetter(result.start_col)}-${colLetter(result.end_col)} of ` +
            `${result.total_cols} total${result.truncated_columns ? ' (column-truncated, re-call with startCol to see the rest)' : ''}` +
            `${result.output_truncated ? ' (OUTPUT TRUNCATED, see warnings)' : ''}. sha256=${sha256.slice(0, 12)}… (lane=${caller}).` +
            (result.warnings.length ? ` ${result.warnings.length} warning(s) — see warnings.` : ''),
        };
      },
    },
    callerHash,
  );
}
