import {
  isGitHubContentBearingWriteTool,
  isGitHubRepositoryWriteTool,
} from '../config/github-operator.js';
import { evaluateBroadcastMnpiGate } from './mnpi-gate.js';

const PERSONAL_LEGAL_CONTENT_FENCED_LANES = new Set(['clo-personal']);

export type GitHubPreShareCode =
  | 'clear'
  | 'personal_legal_boundary'
  | 'protected_content'
  | 'scan_failed';

export interface GitHubPreShareOutcome {
  blocked: boolean;
  code: GitHubPreShareCode;
  reason: string;
}

const CLEAR: GitHubPreShareOutcome = {
  blocked: false,
  code: 'clear',
  reason: 'GitHub repository write passed the protected-content pre-share gate.',
};

function scanNestedStrings(
  value: unknown,
  path: string,
  seen: WeakSet<object>,
): GitHubPreShareOutcome | null {
  if (typeof value === 'string') {
    const gate = evaluateBroadcastMnpiGate({ [path]: value });
    return gate.blocked
      ? { blocked: true, code: 'protected_content', reason: gate.reason }
      : null;
  }

  if (value === null || value === undefined || typeof value === 'boolean' || typeof value === 'number') {
    return null;
  }

  if (typeof value !== 'object') {
    throw new TypeError(`unsupported GitHub argument value at ${path}`);
  }

  if (seen.has(value)) throw new TypeError(`cyclic GitHub arguments at ${path}`);
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        const blocked = scanNestedStrings(value[index], `${path}[${index}]`, seen);
        if (blocked) return blocked;
      }
      return null;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`non-plain GitHub arguments at ${path}`);
    }

    const entries = Object.entries(value as Record<string, unknown>);
    for (let index = 0; index < entries.length; index += 1) {
      const [key, nested] = entries[index]!;

      // Workflow-dispatch input names are caller-controlled object keys. Scan them as content too;
      // use an ordinal audit path so a rejected key is not copied into logs.
      const keyGate = evaluateBroadcastMnpiGate({ [`${path}.key[${index}]`]: key });
      if (keyGate.blocked) {
        return { blocked: true, code: 'protected_content', reason: keyGate.reason };
      }

      const blocked = scanNestedStrings(nested, `${path}.value[${index}]`, seen);
      if (blocked) return blocked;
    }
    return null;
  } finally {
    seen.delete(value);
  }
}

/**
 * Deterministic pre-share control for direct GitHub repository mutations.
 *
 * Every nested string is scanned without byte, field-count, or depth truncation, including object
 * keys used by workflow-dispatch inputs. Any traversal error fails closed. The dedicated
 * clo-personal is additionally refused on broad content-bearing transports because GitHub
 * repositories are company-shared destinations, while clean metadata operations remain available.
 * Exec clean-engineering writes remain available under the same recursive marker scan.
 * This is an MNPI/personal-legal boundary; it is not a general PHI classifier.
 */
export function evaluateGitHubPreShareGate(
  toolName: string,
  callerLane: string | undefined | null,
  args: unknown,
): GitHubPreShareOutcome {
  if (!isGitHubRepositoryWriteTool(toolName)) return CLEAR;

  if (
    isGitHubContentBearingWriteTool(toolName)
    && PERSONAL_LEGAL_CONTENT_FENCED_LANES.has((callerLane || '').trim().toLowerCase())
  ) {
    return {
      blocked: true,
      code: 'personal_legal_boundary',
      reason:
        'Refused: the clo-personal lane cannot publish caller-supplied prose or ' +
        'file content to a company-shared GitHub repository. Use the company CLO/Developer lane for ' +
        'non-personal engineering work; keep personal-legal material in its private tooling.',
    };
  }

  try {
    return scanNestedStrings(args, '$', new WeakSet<object>()) ?? CLEAR;
  } catch {
    const failedClosed = evaluateBroadcastMnpiGate(
      null as unknown as Record<string, string | undefined | null>,
    );
    return { blocked: true, code: 'scan_failed', reason: failedClosed.reason };
  }
}
