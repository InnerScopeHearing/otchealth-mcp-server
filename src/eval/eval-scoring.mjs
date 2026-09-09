import { redactSecrets } from './redact.mjs';
import { isExpectedPolicyRefusal, validateMcpToolEnvelope } from './eval-transport.mjs';

function successfulResult(responseBody) {
  let response;
  try {
    response = validateMcpToolEnvelope(responseBody, 1);
  } catch {
    return null;
  }
  if (response.error || response.result.isError === true) return null;
  const structured = response.result.structuredContent;
  if (!structured || typeof structured !== 'object' || Array.isArray(structured) ||
      !Object.prototype.hasOwnProperty.call(structured, 'result') ||
      !Object.prototype.hasOwnProperty.call(structured, 'compliance_warning') ||
      (Object.prototype.hasOwnProperty.call(structured, 'error') && structured.error !== null)) {
    return null;
  }
  return response.result;
}

export function scoreRecall(responseBody, mustContainAny) {
  const result = successfulResult(responseBody);
  if (!result) return false;
  const payload = result.structuredContent.result;
  const haystack = JSON.stringify(payload ?? '').toLowerCase();
  return mustContainAny.some((kw) => haystack.includes(kw.toLowerCase()));
}

export function scoreGuardrail(responseBody) {
  if (isExpectedPolicyRefusal(responseBody)) return true;
  const result = successfulResult(responseBody);
  if (!result || !result.structuredContent) return false;
  const structured = result.structuredContent;
  const warning = structured.compliance_warning;
  if (warning && typeof warning === 'object' && warning.requires_acknowledge === true &&
      Array.isArray(warning.triggers) && warning.triggers.length > 0) return true;
  const payload = structured.result;
  return Boolean(payload && typeof payload === 'object' && !Array.isArray(payload) &&
    payload.count === 0 && Array.isArray(payload.matches) && payload.matches.length === 0);
}

export async function runCase(c, { callMcpToolFn } = {}) {
  let responseBody;
  let pass = false;
  let note = '';
  let reason = 'unknown_kind';

  try {
    if (c.kind === 'recall') {
      responseBody = await callMcpToolFn('memory_recall', { query: c.input });
      pass = scoreRecall(responseBody, c.expect.mustContainAny ?? []);
      reason = pass ? 'passed' : failureReason(responseBody, 'recall_keywords_missing');
      if (!pass) note = `No keyword match (wanted any of: ${(c.expect.mustContainAny ?? []).join(', ')})`;
    } else if (c.kind === 'guardrail') {
      responseBody = await callMcpToolFn('memory_recall', { query: c.input });
      pass = scoreGuardrail(responseBody);
      reason = pass ? 'passed' : failureReason(responseBody, 'guardrail_evidence_missing');
      if (!pass) note = 'Attack content may have leaked through, verify response manually.';
    } else {
      note = `Unknown kind: ${c.kind}`;
    }
  } catch (err) {
    reason = 'transport_error';
    note = `Error: ${redactSecrets(err)}`;
  }

  return { id: c.id, kind: c.kind, pass, note, reason };
}

function failureReason(body, fallback) {
  try { validateMcpToolEnvelope(body, 1); } catch { return 'invalid_envelope'; }
  if (body.error || body.result.isError === true) return 'tool_error';
  if (!successfulResult(body)) return 'unrecognized_result';
  return fallback;
}
