/**
 * Narrow output-boundary protection for values next to explicit secret-field labels.
 * This is not general secret detection and makes no PHI classification claim.
 */

const LABEL_ASSIGNMENT = /(^|[\s,{;"'])((?:["']?)(?:workspace[ _-]?secret|client[ _-]?secret|secret(?:[ _-]?value)?|api[ _-]?key|access[ _-]?token|refresh[ _-]?token|password|credential|bearer)(?:["']?)[ \t]*[:=][ \t]*)/i;
// Some stored prose uses the explicit label followed by a bare token-like value, without `:` or `=`.
// Require a long non-space token shape so ordinary sentences such as "workspace secret belongs..."
// remain readable.
const BARE_WORKSPACE_SECRET = /(^|[\s,{;"'])(workspace[ _-]?secret)([ \t]+)[A-Za-z0-9][A-Za-z0-9.~+/_-]{15,}={0,2}(?=$|[\s,;}"'])/i;
// Match fields that hold credential values, not descriptive metadata such as token_type,
// token_status, secret_name, or api_key_name. Explicit compound labels remain recognized.
const SECRET_FIELD_NAME = /^(?:secret|secret_value|workspace_secret|client_secret|token|password|credential|api_key|bearer|access_token|refresh_token)$/i;
const REDACTION_MARKER = '[REDACTED: explicitly labeled secret]';

function normalizeFieldName(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, '$1_$2');
}

export function isExplicitSecretFieldName(key: string): boolean {
  const normalized = normalizeFieldName(key);
  return SECRET_FIELD_NAME.test(normalized.replace(/[\s-]+/g, '_'));
}

/** Redact only the value portion of an explicit assignment, through the end of its line. */
export function redactExplicitSecretAssignments(text: string): string {
  const lines = text.split(/(?<=\n)/);
  const output: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const assignment = LABEL_ASSIGNMENT.exec(line);
    const bareWorkspaceSecret = BARE_WORKSPACE_SECRET.exec(line);
    const match = [assignment, bareWorkspaceSecret]
      .filter((candidate): candidate is RegExpExecArray => candidate !== null)
      .sort((left, right) => left.index - right.index)[0];
    if (!match || match.index === undefined) {
      output.push(line);
      continue;
    }
    const labelStart = match.index + match[1]!.length;
    const assignmentEnd = assignment && match === assignment
      ? labelStart + match[2]!.length
      : labelStart + match[2]!.length + match[3]!.length;
    const lineEnding = line.endsWith('\n') ? '\n' : '';
    const prefix = line.slice(0, assignmentEnd);
    const inlineValue = line.slice(assignmentEnd).replace(/\r?\n$/, '').trim();
    output.push(`${prefix}${REDACTION_MARKER}${lineEnding}`);
    // YAML block scalar values and empty assignments can continue on indented following lines.
    // Consume the whole indented value block, preserving only its final newline.
    if (assignment && (inlineValue === '' || /^[|>][+-]?$/.test(inlineValue)) && index + 1 < lines.length) {
      const labelIndent = /^\s*/.exec(line)?.[0].length ?? 0;
      let next = index + 1;
      while (next < lines.length) {
        const candidate = lines[next]!;
        const content = candidate.replace(/\r?\n$/, '');
        if (content.trim() === '') {
          next += 1;
          continue;
        }
        const indent = /^\s*/.exec(content)?.[0].length ?? 0;
        if (indent <= labelIndent) {
          // An empty `key:` assignment may use an unindented next-line scalar in stored text.
          if (next === index + 1 && inlineValue === '') {
            // But an obvious sibling mapping key closes the empty value instead of becoming data.
            if (/^\s*[A-Za-z_][A-Za-z0-9_.-]*\s*:/.test(content)) break;
            next += 1;
            continue;
          }
          break;
        }
        next += 1;
      }
      if (next > index + 1) index = next - 1;
    }
  }
  return output.join('');
}

/**
 * Sanitize content-bearing strings and explicitly named secret fields recursively while leaving
 * IDs, citation numbers, paths, and other ordinary metadata intact. A `{key,value}` entity whose
 * key is itself a secret label is treated as an explicitly labeled field too.
 */
export function sanitizeRetrievedPayload<T>(value: T): T {
  if (typeof value === 'string') return redactExplicitSecretAssignments(value) as T;
  if (Array.isArray(value)) return value.map((item) => sanitizeRetrievedPayload(item)) as T;
  if (value === null || typeof value !== 'object') return value;

  const source = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  const labeledKey = typeof source.key === 'string' && isExplicitSecretFieldName(source.key);
  for (const [key, item] of Object.entries(source)) {
    const sensitiveKey = isExplicitSecretFieldName(key) || (labeledKey && key === 'value');
    if (sensitiveKey && (typeof item === 'string' || typeof item === 'number' || (item !== null && typeof item === 'object'))) {
      result[key] = REDACTION_MARKER;
    } else {
      result[key] = sanitizeRetrievedPayload(item);
    }
  }
  return result as T;
}

/** Sanitize the complete tool payload so early returns, summaries, and error data share one boundary. */
export function sanitizeToolResult<T extends { data: unknown; summary: string }>(result: T): T {
  return sanitizeRetrievedPayload(result);
}

