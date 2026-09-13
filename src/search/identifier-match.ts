/** Narrow identifier matching shared by retrieval backends and federation. */
export function opaqueIdentifierQuery(query: string): string | null {
  const value = query.trim();
  if (/^[a-z0-9][a-z0-9_-]{0,40}__[A-Za-z0-9][A-Za-z0-9_=-]{2,127}$/.test(value)) return value;
  return /^(?=.*\d)[A-Z0-9]{8,64}$/.test(value) ? value : null;
}

export function literalIndex(text: string, token: string): number {
  let at = text.indexOf(token);
  while (at >= 0) {
    const before = at === 0 ? '' : text[at - 1];
    const after = at + token.length >= text.length ? '' : text[at + token.length];
    if (!/[A-Za-z0-9_]/.test(before) && !/[A-Za-z0-9_]/.test(after)) return at;
    at = text.indexOf(token, at + token.length);
  }
  return -1;
}

/** Keep a literal witness even when its location is beyond the normal leading snippet. */
export function identifierEvidenceSnippet(text: string, token: string, max = 1200): string | null {
  const at = literalIndex(text, token);
  if (at < 0) return null;
  if (text.length <= max) return text;
  const start = Math.max(0, Math.min(at - Math.floor((max - token.length) / 2), text.length - max));
  return `${start ? '…' : ''}${text.slice(start, start + max)}${start + max < text.length ? '…' : ''}`;
}
