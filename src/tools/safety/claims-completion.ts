export type ClaimsVerdict = 'pass' | 'revise' | 'block';
export type ClaimsSeverity = 'low' | 'medium' | 'high';

interface ClaimsViolation {
  phrase: string;
  rule: string;
  severity: ClaimsSeverity;
  fix: string;
}

export interface ClaimsReview {
  verdict: ClaimsVerdict;
  risk: number;
  violations: ClaimsViolation[];
  compliant_rewrite: string;
  notes: string;
}

export interface ClaimsCompletion {
  text: string;
  model: string;
  finishReason?: string;
  refusal?: string;
  usage?: unknown;
}

export interface ClaimsCompletionDiagnostics {
  model: string;
  finishReason?: string;
  promptTokens?: number;
  completionTokens?: number;
  refusal: boolean;
}

/** Output failures retain safe provider metadata, never copy excerpts. */
export class InvalidClaimsCompletionError extends Error {
  readonly code: string;
  readonly diagnostics: ClaimsCompletionDiagnostics;

  constructor(
    code: string,
    diagnostics: ClaimsCompletionDiagnostics,
  ) {
    super(`invalid_model_output:${code}`);
    this.name = 'InvalidClaimsCompletionError';
    this.code = code;
    this.diagnostics = diagnostics;
  }
}

function hasExactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

export function completionDiagnostics(completion: ClaimsCompletion): ClaimsCompletionDiagnostics {
  const usage = typeof completion.usage === 'object' && completion.usage !== null
    ? completion.usage as Record<string, unknown>
    : {};
  return {
    model: completion.model,
    finishReason: completion.finishReason,
    promptTokens: typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : undefined,
    completionTokens: typeof usage.completion_tokens === 'number' ? usage.completion_tokens : undefined,
    refusal: Boolean(completion.refusal),
  };
}

/** Accept only complete, schema-valid JSON completions consistent with the claims prompt. */
export function parseClaimsCompletion(completion: ClaimsCompletion): ClaimsReview {
  const diagnostics = completionDiagnostics(completion);
  function fail(code: string): never {
    throw new InvalidClaimsCompletionError(code, diagnostics);
  }

  if (completion.refusal) fail('model_refusal');
  if (completion.finishReason !== 'stop') {
    if (completion.finishReason === 'length') fail('incomplete_completion');
    fail(completion.finishReason === 'content_filter' ? 'content_filtered' : 'unexpected_finish_reason');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(completion.text);
  } catch {
    fail('malformed_json');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) fail('invalid_schema');

  const value = parsed as Record<string, unknown>;
  if (!hasExactKeys(value, ['verdict', 'risk', 'violations', 'compliant_rewrite', 'notes'])) fail('invalid_schema');
  const verdict = value.verdict;
  const risk = value.risk;
  const rewrite = value.compliant_rewrite;
  const notes = value.notes;
  const rawViolations = value.violations;
  if (verdict !== 'pass' && verdict !== 'revise' && verdict !== 'block') fail('invalid_verdict');
  if (typeof risk !== 'number' || !Number.isFinite(risk) || risk < 0 || risk > 100) fail('invalid_risk');
  if (typeof rewrite !== 'string' || rewrite.trim().length === 0) fail('invalid_rewrite');
  if (typeof notes !== 'string') fail('invalid_notes');
  if (!Array.isArray(rawViolations)) fail('invalid_violations');

  const violations: ClaimsViolation[] = [];
  for (const item of rawViolations) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) fail('invalid_violations');
    const violation = item as Record<string, unknown>;
    if (!hasExactKeys(violation, ['phrase', 'rule', 'severity', 'fix'])
      || typeof violation.phrase !== 'string' || !violation.phrase.trim()
      || typeof violation.rule !== 'string' || !violation.rule.trim()
      || typeof violation.fix !== 'string' || !violation.fix.trim()
      || (violation.severity !== 'low' && violation.severity !== 'medium' && violation.severity !== 'high')) {
      fail('invalid_violations');
    }
    violations.push({
      phrase: violation.phrase,
      rule: violation.rule,
      fix: violation.fix,
      severity: violation.severity,
    });
  }

  const hasHighSeverity = violations.some((violation) => violation.severity === 'high');
  if (verdict === 'pass' && violations.length !== 0) fail('pass_with_violations');
  if (verdict === 'revise' && (violations.length === 0 || hasHighSeverity)) fail('inconsistent_revise_verdict');
  if (verdict === 'block' && !hasHighSeverity) fail('inconsistent_block_verdict');

  return { verdict, risk, violations, compliant_rewrite: rewrite, notes };
}
