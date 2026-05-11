/**
 * regulated_data_guardrail — per ADR-001 Section 10.
 *
 * Scans an outbound tool response for compliance-sensitive content and, if
 * any trigger fires, attaches a compliance_warning field. The caller must
 * pass acknowledge_warning: true to render the data.
 *
 * Triggers (verbatim from ADR Section 10):
 *  - INND ticker mentions in unscheduled marketing contexts
 *  - Patent claim language (OTCHealth and InnerScope own zero patents)
 *  - 510(k) clearance claims (Soundwave LLC owns the Sontro 510(k))
 *  - A-grade HearAdvisor claims (MatriX is B-grade, never A)
 *  - Pre-shipment availability claims (no FDA Establishment Registration yet)
 *  - TReO described as a hearing aid (it is a Personal Sound Amplifier)
 */

export interface ComplianceWarning {
  triggers: string[];
  reason: string;
  requires_acknowledge: true;
  details: Array<{
    trigger_id: string;
    matched_excerpt: string;
    explanation: string;
  }>;
}

interface TriggerDef {
  id: string;
  pattern: RegExp;
  explanation: string;
}

const TRIGGERS: TriggerDef[] = [
  {
    id: 'innd_ticker_marketing',
    pattern: /\bINND\b/i,
    explanation:
      'Reference to ticker INND in connector output. Reg FD risk if disseminated through a non-IR channel without simultaneous public disclosure.',
  },
  {
    id: 'patent_claim',
    pattern: /\bpatent(?:ed|s|-pending)?\b/i,
    explanation:
      'Patent-claim language detected. OTCHealth and InnerScope own zero patents. Strip or replace before publishing.',
  },
  {
    id: 'fda_510k_overclaim',
    pattern: /\b510\(?k\)?\b/i,
    explanation:
      'FDA 510(k) reference detected. The Sontro 510(k) belongs to Soundwave LLC, not OTCHealth. MatriX has no 510(k). Confirm ownership before publishing.',
  },
  {
    id: 'hearadvisor_a_grade',
    pattern: /\bHearAdvisor\b[^.\n]*\b(?:A[- ]?grade|grade[- ]?A)\b/i,
    explanation:
      'A-grade HearAdvisor claim detected. MatriX is HearAdvisor B-grade, never A. Correct or remove before publishing.',
  },
  {
    id: 'pre_shipment_availability',
    pattern:
      /\b(?:available now|ships?\s+(?:today|now|immediately)|now\s+(?:shipping|available))\b/i,
    explanation:
      'Pre-shipment availability claim detected. FDA Establishment Registration not yet filed; "available now" claims may overstate readiness.',
  },
  {
    id: 'treo_hearing_aid',
    pattern: /\bTReO\b[^.\n]*\bhearing[- ]?aid\b/i,
    explanation:
      'TReO described as a hearing aid. TReO is a Personal Sound Amplifier (PSAP), not a hearing aid. Correct before publishing.',
  },
];

function collectStrings(value: unknown, out: string[], maxItems = 1000): void {
  if (out.length >= maxItems) return;
  if (typeof value === 'string') {
    out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) collectStrings(v, out, maxItems);
    return;
  }
  if (value && typeof value === 'object') {
    for (const v of Object.values(value as Record<string, unknown>)) {
      collectStrings(v, out, maxItems);
    }
  }
}

export function scanForCompliance(payload: unknown): ComplianceWarning | null {
  const strings: string[] = [];
  collectStrings(payload, strings);
  const details: ComplianceWarning['details'] = [];
  const seenTriggers = new Set<string>();
  for (const s of strings) {
    for (const trigger of TRIGGERS) {
      if (seenTriggers.has(trigger.id)) continue;
      const m = s.match(trigger.pattern);
      if (m) {
        seenTriggers.add(trigger.id);
        const start = Math.max(0, (m.index ?? 0) - 30);
        const end = Math.min(s.length, (m.index ?? 0) + m[0].length + 30);
        details.push({
          trigger_id: trigger.id,
          matched_excerpt: s.slice(start, end),
          explanation: trigger.explanation,
        });
      }
    }
    if (seenTriggers.size === TRIGGERS.length) break;
  }
  if (details.length === 0) return null;
  return {
    triggers: details.map((d) => d.trigger_id),
    reason:
      'Output contains regulated or investor-sensitive content. Pass acknowledge_warning=true to render anyway.',
    requires_acknowledge: true,
    details,
  };
}

/**
 * Apply the guardrail to a tool result. If the caller did not pass
 * acknowledge_warning=true and the content trips a rule, return a sanitized
 * result that surfaces the warning without leaking the underlying payload.
 */
export function applyGuardrail<T>(
  result: T,
  acknowledged: boolean,
): { result: T | null; warning: ComplianceWarning | null } {
  const warning = scanForCompliance(result);
  if (!warning) return { result, warning: null };
  if (acknowledged) return { result, warning };
  return { result: null, warning };
}
