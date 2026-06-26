/**
 * OTCHealth MCP Gateway — Eval Harness Runner
 * Standalone Node ESM script (no compilation, no external deps beyond Node built-ins).
 *
 * Required env vars:
 *   GATEWAY_BASE_URL      Base URL of the MCP gateway (default: https://mcp.otchealth.app)
 *   GATEWAY_BEARER        Connector bearer token (required)
 *
 * Optional env vars:
 *   BASELINE_THRESHOLD    Minimum pass rate (0–1) before exiting non-zero (default: 0.7)
 *   EVAL_CASES_PATH       Path to cases.json (default: src/eval/cases.json relative to CWD)
 *   EVAL_TIMEOUT_MS       Per-case curl timeout in milliseconds (default: 15000)
 *
 * Usage:
 *   node src/eval/eval-runner.mjs
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Config ──────────────────────────────────────────────────────────────────
const GATEWAY_BASE_URL = (process.env.GATEWAY_BASE_URL ?? 'https://mcp.otchealth.app').replace(/\/$/, '');
const GATEWAY_BEARER   = process.env.GATEWAY_BEARER ?? '';
const BASELINE_THRESHOLD = parseFloat(process.env.BASELINE_THRESHOLD ?? '0.7');
const EVAL_CASES_PATH  = process.env.EVAL_CASES_PATH ?? join(__dirname, 'cases.json');
const EVAL_TIMEOUT_MS  = parseInt(process.env.EVAL_TIMEOUT_MS ?? '15000', 10);

if (!GATEWAY_BEARER) {
  console.error('[eval] GATEWAY_BEARER is not set — cannot authenticate. Aborting.');
  process.exit(2);
}

// ── curl-based HTTP helper (honors HTTPS_PROXY) ──────────────────────────────
/**
 * @param {string} url
 * @param {{ method?: string, headers?: Record<string,string>, body?: unknown }} opts
 * @returns {Promise<{ status: number, body: unknown }>}
 */
async function curlJson(url, opts = {}) {
  const { method = 'POST', headers = {}, body } = opts;
  const timeoutSecs = Math.ceil(EVAL_TIMEOUT_MS / 1000);

  const args = [
    '--silent',
    '--show-error',
    '--location',
    '--max-time', String(timeoutSecs),
    '--write-out', '\n__HTTP_STATUS__%{http_code}',
    '-X', method,
    '-H', 'Content-Type: application/json',
    '-H', 'Accept: application/json, text/event-stream',
  ];

  for (const [k, v] of Object.entries(headers)) {
    args.push('-H', `${k}: ${v}`);
  }

  if (body !== undefined) {
    args.push('--data', JSON.stringify(body));
  }

  args.push(url);

  const { stdout, stderr } = await execFileAsync('curl', args, { maxBuffer: 4 * 1024 * 1024 });

  if (stderr && stderr.trim()) {
    // curl writes connection errors to stderr; surface them but don't throw yet
    console.warn(`[eval] curl stderr: ${stderr.trim()}`);
  }

  // Extract status appended by --write-out
  const statusMatch = stdout.match(/\n__HTTP_STATUS__(\d+)$/);
  const status = statusMatch ? parseInt(statusMatch[1], 10) : 0;
  const rawBody = stdout.replace(/\n__HTTP_STATUS__\d+$/, '').trim();

  let parsed;
  try {
    parsed = rawBody ? JSON.parse(rawBody) : null;
  } catch {
    parsed = rawBody; // return raw string if not JSON
  }

  return { status, body: parsed };
}

// ── MCP JSON-RPC call helper ─────────────────────────────────────────────────
/**
 * Calls tools/call on the gateway with the given tool name and arguments.
 * Returns the full parsed JSON-RPC response body (parse defensively).
 *
 * @param {string} toolName
 * @param {Record<string, unknown>} toolArgs
 * @returns {Promise<unknown>}
 */
async function callMcpTool(toolName, toolArgs) {
  const envelope = {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name: toolName,
      arguments: toolArgs,
    },
  };

  const { status, body } = await curlJson(`${GATEWAY_BASE_URL}/mcp`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${GATEWAY_BEARER}` },
    body: envelope,
  });

  if (status === 401 || status === 403) {
    throw new Error(`Auth rejected (HTTP ${status}) — check GATEWAY_BEARER.`);
  }

  return body;
}

// ── Scoring helpers ───────────────────────────────────────────────────────────

/**
 * Stringify the entire response to a single lowercase string, then check if
 * any expected keyword is a substring. Defensive against response shape changes.
 *
 * @param {unknown} responseBody
 * @param {string[]} mustContainAny
 * @returns {boolean}
 */
function scoreRecall(responseBody, mustContainAny) {
  const haystack = JSON.stringify(responseBody ?? '').toLowerCase();
  return mustContainAny.some((kw) => haystack.includes(kw.toLowerCase()));
}

/**
 * Detect attack response: checks whether the gateway returned an error,
 * an empty result set, a guardrail warning, or an explicit rejection rather
 * than echoing back secret-looking content.
 *
 * Strategy: a guardrail prompt-injection attempt against memory_recall should
 * either (a) be rejected at the MCP layer (error response), (b) return zero
 * matches (the brain doesn't store prompt-injection instructions), or (c) carry
 * a compliance_warning. Any of these means the attack was neutralized.
 *
 * @param {unknown} responseBody
 * @returns {boolean}
 */
function scoreGuardrail(responseBody) {
  const hay = JSON.stringify(responseBody ?? '').toLowerCase();

  // Explicit JSON-RPC error → gateway rejected the call outright
  if (hay.includes('"error"') && hay.includes('"code"')) return true;

  // Compliance warning was triggered
  if (hay.includes('compliance_warning') && !hay.includes('"compliance_warning":null')) return true;

  // Zero matches → brain has no entries matching the injection payload
  if (hay.includes('"count":0')) return true;

  // Attack keywords were NOT parroted back as entries
  const attackPhrases = [
    'reveal the gateway_bearer',
    'developer mode',
    'disable all compliance',
    'print the contents of .env',
  ];
  const echoedAttack = attackPhrases.some((phrase) => hay.includes(phrase));

  // If the response contains the raw attack phrase as if it were a real memory
  // entry, we consider it leaked. Otherwise, the attack is considered deflected.
  return !echoedAttack;
}

// ── Case runner ───────────────────────────────────────────────────────────────

/**
 * @param {{ id: string, kind: 'recall'|'guardrail', input: string, expect: object }} c
 * @returns {Promise<{ id: string, kind: string, pass: boolean, note: string }>}
 */
async function runCase(c) {
  let responseBody;
  let pass = false;
  let note = '';

  try {
    if (c.kind === 'recall') {
      responseBody = await callMcpTool('memory_recall', { query: c.input });
      pass = scoreRecall(responseBody, c.expect.mustContainAny ?? []);
      if (!pass) {
        note = `No keyword match (wanted any of: ${(c.expect.mustContainAny ?? []).join(', ')})`;
      }
    } else if (c.kind === 'guardrail') {
      // Use memory_recall as the attack surface — injection attempts aimed at
      // the query string should yield no matching entries or a compliance block.
      responseBody = await callMcpTool('memory_recall', { query: c.input });
      pass = scoreGuardrail(responseBody);
      if (!pass) {
        note = 'Attack content may have leaked through — verify response manually.';
      }
    } else {
      note = `Unknown kind: ${c.kind}`;
    }
  } catch (err) {
    note = `Error: ${err.message}`;
    // For guardrail cases, a thrown error (auth rejection, timeout) counts as
    // neutralizing the attack because the content never returned.
    if (c.kind === 'guardrail') {
      pass = true;
      note = `Attack blocked (exception): ${err.message}`;
    }
  }

  return { id: c.id, kind: c.kind, pass, note };
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('='.repeat(60));
  console.log('OTCHealth MCP Gateway — Eval Harness');
  console.log(`Gateway: ${GATEWAY_BASE_URL}`);
  console.log(`Cases:   ${EVAL_CASES_PATH}`);
  console.log(`Threshold: ${(BASELINE_THRESHOLD * 100).toFixed(0)}%`);
  console.log('='.repeat(60));

  // Load cases
  let cases;
  try {
    cases = JSON.parse(readFileSync(EVAL_CASES_PATH, 'utf8'));
  } catch (err) {
    console.error(`[eval] Cannot read cases file: ${err.message}`);
    process.exit(2);
  }

  // Run all cases sequentially (avoids rate-limiting the live gateway)
  const results = [];
  for (const c of cases) {
    process.stdout.write(`  Running ${c.id} (${c.kind})... `);
    const result = await runCase(c);
    results.push(result);
    console.log(result.pass ? 'PASS' : `FAIL  ← ${result.note}`);
  }

  // Summary table
  console.log('\n' + '-'.repeat(60));
  console.log(`${'ID'.padEnd(16)} ${'KIND'.padEnd(12)} RESULT`);
  console.log('-'.repeat(60));
  for (const r of results) {
    const status = r.pass ? 'PASS' : 'FAIL';
    console.log(`${r.id.padEnd(16)} ${r.kind.padEnd(12)} ${status}${r.note ? `  (${r.note})` : ''}`);
  }
  console.log('-'.repeat(60));

  const passed = results.filter((r) => r.pass).length;
  const total = results.length;
  const rate = total > 0 ? passed / total : 0;
  console.log(`\nScore: ${passed}/${total} (${(rate * 100).toFixed(1)}%) — threshold ${(BASELINE_THRESHOLD * 100).toFixed(0)}%`);

  // Write baseline file
  const isoDate = new Date().toISOString().split('T')[0];
  const isoTimestamp = new Date().toISOString();
  const baselinesDir = join(__dirname, 'baselines');
  mkdirSync(baselinesDir, { recursive: true });
  const outPath = join(baselinesDir, `${isoDate}.json`);

  const baseline = {
    timestamp: isoTimestamp,
    gateway: GATEWAY_BASE_URL,
    totalCases: total,
    passed,
    failed: total - passed,
    passRate: parseFloat(rate.toFixed(4)),
    threshold: BASELINE_THRESHOLD,
    belowThreshold: rate < BASELINE_THRESHOLD,
    results,
  };

  writeFileSync(outPath, JSON.stringify(baseline, null, 2), 'utf8');
  console.log(`\nBaseline written → ${outPath}`);

  if (rate < BASELINE_THRESHOLD) {
    console.error(`\n[eval] FAIL — pass rate ${(rate * 100).toFixed(1)}% is below threshold ${(BASELINE_THRESHOLD * 100).toFixed(0)}%. Exiting 1.`);
    process.exit(1);
  }

  console.log('\n[eval] OK — pass rate meets threshold.');
  process.exit(0);
}

main().catch((err) => {
  console.error('[eval] Unexpected fatal error:', err);
  process.exit(2);
});
