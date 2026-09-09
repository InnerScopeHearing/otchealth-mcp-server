// Allowlisted operational evidence only. Never persist prompts, responses, notes or URLs.
export function makeBaseline(results, threshold, timestamp = new Date().toISOString()) {
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) throw new Error('Invalid eval threshold');
  if (!Array.isArray(results) || results.length > 1000) throw new Error('Invalid eval case count');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(timestamp)) throw new Error('Invalid eval timestamp');
  const reasons = new Set(['passed', 'transport_error', 'invalid_envelope', 'tool_error', 'unrecognized_result', 'guardrail_evidence_missing', 'recall_keywords_missing', 'unknown_kind']);
  const cases = results.map((r, i) => ({
    // Ordinal is stable for a given cases file, without copying arbitrary caller-controlled IDs.
    caseIndex: i + 1,
    kind: r.kind === 'recall' || r.kind === 'guardrail' ? r.kind : 'unknown',
    pass: r.pass === true,
    reason: reasons.has(r.reason) ? r.reason : 'unrecognized_result',
  }));
  const passed = cases.filter(r => r.pass).length;
  const passRate = cases.length ? passed / cases.length : 0;
  return { schemaVersion: 1, timestamp, totalCases: cases.length, passed, failed: cases.length - passed,
    passRate, threshold, belowThreshold: passRate < threshold, allPassed: cases.length > 0 && passed === cases.length, cases };
}

export async function emitBaseline(baseline, stream = process.stdout) {
  // Await the write callback before process.exit can truncate a piped awslogs record.
  await new Promise((resolve, reject) => stream.write(`EVAL_BASELINE_V1 ${JSON.stringify(baseline)}\n`, err => err ? reject(err) : resolve()));
}
