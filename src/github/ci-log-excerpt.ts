/**
 * Pure helpers that turn a raw GitHub Actions job log into a bounded, secret-redacted excerpt of the
 * FAILED steps only. No I/O and no environment access, so every rule is unit-testable.
 *
 * Why this exists: github_workflow_run_list_jobs returns step NAMES only, so the CTO lane could see
 * that a step failed but never why. This is the smallest read path that closes that gap: the tail of
 * each failed step, redacted, hard-capped in lines and bytes.
 *
 * Redaction is best-effort pattern matching for OBVIOUS secrets (token formats, credential
 * assignments, URL credentials, signed-URL parameters, private-key blocks, long mixed-case blobs).
 * GitHub already masks registered secrets as *** in job logs; this is a second layer, not a guarantee.
 */

export const CI_LOG_TAIL_LINES = 200;
/** Total excerpt text, in UTF-8 bytes, across every step of one response. */
export const CI_LOG_MAX_EXCERPT_BYTES = 28_000;
/** Floor for one excerpt entry's share of the total, so one long line cannot empty an entry. */
export const CI_LOG_MIN_ENTRY_BYTES = 1_800;
export const CI_LOG_MAX_LINE_CHARS = 500;
/** Longest prefix of a line that is ever run through the redaction patterns. */
const CI_LOG_MAX_REDACT_INPUT_CHARS = 8_000;
export const CI_LOG_MAX_FAILED_JOBS = 5;
export const CI_LOG_MAX_FAILED_STEPS_PER_JOB = 3;
/** Only the newest bytes of a job log are kept: the failing step is at the end. */
export const CI_LOG_KEEP_BYTES = 4 * 1024 * 1024;
/** A download larger than this is abandoned outright. */
export const CI_LOG_HARD_CAP_BYTES = 64 * 1024 * 1024;
export const CI_LOG_REDACTED = '[REDACTED]';

export type JobLogResult =
  | { status: 'ok'; text: string; headTruncated: boolean }
  | { status: 'unavailable' }
  | { status: 'failed'; reason: string };

// ── Redaction ──────────────────────────────────────────────────────────────────

const PEM_BEGIN = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/;
const PEM_END = /-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/;

const TOKEN_FORMATS: readonly RegExp[] = [
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA|AIPA)[A-Z0-9]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /xox[abposr]-[A-Za-z0-9-]{10,}/g,
  /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}/g,
  /AIza[0-9A-Za-z_-]{35}/g,
  /npm_[A-Za-z0-9]{36}/g,
  /SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g,
];
const URL_CREDENTIALS = /([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi;
const AUTH_SCHEME = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const QUERY_SECRET =
  /([?&](?:sig|signature|x-amz-signature|x-amz-security-token|x-amz-credential|x-goog-signature|x-goog-credential|access_token|token|api_key|apikey|key)=)[^&\s"'<>]+/gi;
// NAME[:=]VALUE where NAME contains a credential word (GH_TOKEN: x, "client_secret": "x", password=x).
const ASSIGNMENT =
  /(password|passwd|secret|token|api[_-]?key|apikey|private[_-]?key|access[_-]?key|credentials?|bearer|authorization|signature)(["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;&"'<>]+)/gi;
// Long base64-looking runs that mix upper case, lower case and digits. Commit SHAs, image digests
// (lower-case hex) and slash/dash separated paths are deliberately NOT matched.
const HIGH_ENTROPY = /[A-Za-z0-9+/=]{40,}/g;
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f]/g;

export function redactLine(line: string): string {
  let out = line;
  for (const pattern of TOKEN_FORMATS) out = out.replace(pattern, CI_LOG_REDACTED);
  out = out.replace(URL_CREDENTIALS, `$1${CI_LOG_REDACTED}@`);
  out = out.replace(AUTH_SCHEME, `$1 ${CI_LOG_REDACTED}`);
  out = out.replace(QUERY_SECRET, `$1${CI_LOG_REDACTED}`);
  out = out.replace(ASSIGNMENT, `$1$2${CI_LOG_REDACTED}`);
  out = out.replace(HIGH_ENTROPY, (run) =>
    /[A-Z]/.test(run) && /[a-z]/.test(run) && /\d/.test(run) ? CI_LOG_REDACTED : run);
  return out;
}

/**
 * Redact a sequence of log lines. Private-key blocks are dropped whole, blank lines are removed, and
 * each line is capped at CI_LOG_MAX_LINE_CHARS after redaction.
 */
export function redactLines(texts: readonly string[]): string[] {
  const out: string[] = [];
  let inPem = false;
  for (const raw of texts) {
    const text = raw.length > CI_LOG_MAX_REDACT_INPUT_CHARS ? raw.slice(0, CI_LOG_MAX_REDACT_INPUT_CHARS) : raw;
    if (inPem) {
      if (PEM_END.test(text)) inPem = false;
      continue;
    }
    if (PEM_BEGIN.test(text)) {
      inPem = !PEM_END.test(text);
      out.push('[REDACTED PRIVATE KEY BLOCK]');
      continue;
    }
    const cleaned = redactLine(text);
    if (cleaned.trim() === '') continue;
    out.push(cleaned.length > CI_LOG_MAX_LINE_CHARS ? `${cleaned.slice(0, CI_LOG_MAX_LINE_CHARS)}...[truncated]` : cleaned);
  }
  return out;
}

// ── Log parsing and step attribution ───────────────────────────────────────────

export interface ParsedLogLine {
  /** Epoch ms from the line's timestamp prefix (carried forward for continuation lines), or null. */
  ts: number | null;
  text: string;
}

const TS_PREFIX = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z ?/;

/** Split a job log into lines, strip timestamp prefixes, ANSI colour codes and control characters. */
export function parseJobLog(logText: string): ParsedLogLine[] {
  const body = logText.charCodeAt(0) === 0xfeff ? logText.slice(1) : logText;
  const out: ParsedLogLine[] = [];
  let carry: number | null = null;
  for (const rawLine of body.split(/\r?\n/)) {
    let ts: number | null = carry;
    let text = rawLine;
    const match = TS_PREFIX.exec(rawLine);
    if (match) {
      const whole = Date.parse(`${match[1]}Z`);
      if (Number.isFinite(whole)) {
        ts = whole + Number((match[2] ?? '0').padEnd(3, '0').slice(0, 3));
        carry = ts;
      }
      text = rawLine.slice(match[0].length);
    }
    out.push({ ts, text: text.replace(ANSI, '').replace(CONTROL_CHARS, '') });
  }
  return out;
}

export interface StepWindow {
  number: number | null;
  name: string;
  startMs: number | null;
  endMs: number | null;
}

function parseMs(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** Build a step window from one entry of a job's `steps` array (GitHub REST shape). */
export function stepWindow(step: unknown): StepWindow {
  const s = (step !== null && typeof step === 'object' ? step : {}) as Record<string, unknown>;
  return {
    number: typeof s.number === 'number' && Number.isInteger(s.number) ? s.number : null,
    name: typeof s.name === 'string' ? s.name.slice(0, 200) : '(unnamed step)',
    startMs: parseMs(s.started_at),
    endMs: parseMs(s.completed_at),
  };
}

export interface StepExcerpt {
  step_number: number | null;
  step_name: string;
  /** step_window: lines inside the step's timestamps. job_tail: no usable timestamps, last lines of the job. */
  attribution: 'step_window' | 'job_tail';
  line_count: number;
  /** True when earlier lines were dropped to honour the line or byte cap. */
  truncated: boolean;
  excerpt: string;
}

/** One entry's byte budget when `entryCount` excerpts share CI_LOG_MAX_EXCERPT_BYTES. */
export function entryBudgetBytes(entryCount: number): number {
  return Math.max(CI_LOG_MIN_ENTRY_BYTES, Math.floor(CI_LOG_MAX_EXCERPT_BYTES / Math.max(1, entryCount)));
}

/**
 * Excerpt for one failed step: the last CI_LOG_TAIL_LINES redacted lines of its timestamp window
 * (step timestamps have 1 s resolution, so the window ends at the close of its final second), kept
 * within `budgetBytes` by dropping the OLDEST lines first. With no usable window the tail of the whole
 * job log is used instead.
 */
export function buildStepExcerpt(lines: readonly ParsedLogLine[], step: StepWindow | null, budgetBytes: number): StepExcerpt {
  let selected: readonly ParsedLogLine[] = lines;
  let attribution: StepExcerpt['attribution'] = 'job_tail';
  if (step && step.startMs !== null && step.endMs !== null) {
    const start = step.startMs;
    const end = step.endMs + 999;
    const inWindow = lines.filter((line) => line.ts !== null && line.ts >= start && line.ts <= end);
    if (inWindow.length > 0) {
      selected = inWindow;
      attribution = 'step_window';
    }
  }
  const redacted = redactLines(selected.map((line) => line.text));
  const tail = redacted.slice(-CI_LOG_TAIL_LINES);
  let truncated = redacted.length > tail.length;
  const kept: string[] = [];
  let bytes = 0;
  for (let i = tail.length - 1; i >= 0; i -= 1) {
    const cost = Buffer.byteLength(tail[i] as string, 'utf8') + 1;
    if (bytes + cost > budgetBytes) {
      truncated = true;
      break;
    }
    kept.push(tail[i] as string);
    bytes += cost;
  }
  kept.reverse();
  return {
    step_number: step?.number ?? null,
    step_name: step?.name ?? '(job log tail)',
    attribution,
    line_count: kept.length,
    truncated,
    excerpt: kept.join('\n'),
  };
}

// ── Bounded tail reader ────────────────────────────────────────────────────────

/**
 * Read a response body but keep only its newest `keepBytes`. Fails (throws) when the body exceeds
 * `hardCapBytes` or takes longer than `timeoutMs`. `headTruncated` reports that older bytes were
 * dropped, so the first retained line may be partial.
 */
export async function readResponseTail(
  response: Response,
  keepBytes: number,
  hardCapBytes: number,
  timeoutMs: number,
): Promise<{ bytes: Buffer; headTruncated: boolean }> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('missing response body');
  let chunks: Buffer[] = [];
  let held = 0;
  let total = 0;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    void reader.cancel().catch(() => undefined);
  }, timeoutMs);
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > hardCapBytes) {
        try { await reader.cancel(); } catch { /* keep the size failure */ }
        throw new Error('response too large');
      }
      chunks.push(Buffer.from(value));
      held += value.byteLength;
      if (held > keepBytes * 2) {
        const tail = Buffer.concat(chunks, held).subarray(held - keepBytes);
        chunks = [Buffer.from(tail)];
        held = tail.length;
      }
    }
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
  }
  if (timedOut) throw new Error('response body timed out');
  let bytes = Buffer.concat(chunks, held);
  if (bytes.length > keepBytes) bytes = bytes.subarray(bytes.length - keepBytes);
  return { bytes, headTruncated: total > keepBytes };
}
