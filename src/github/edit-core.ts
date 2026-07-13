/**
 * edit-core — the PURE, env-free core of github_edit_file. Kept in its own module (no imports that
 * touch loadEnv) so the safety model is unit-tested directly without the whole env config loading.
 * (write-client.ts calls loadEnv() at module scope; importing it into a bare test throws.)
 */

/**
 * planStrEdit — replace old_str with new_str in `text`, or THROW LOUD on an ambiguous/absent match.
 *
 * SAFETY MODEL: old_str must match EXACTLY ONCE unless replace_all is set. Zero matches -> throw.
 * Two-or-more without replace_all -> throw with the count. Never silently edit the first occurrence.
 *
 * Replacement is LITERAL: rebuilt via `text.split(old_str).join(new_str)`, NOT String.replace(), so a
 * `$` in new_str (`$&`, `$1`, `$$`) is inserted verbatim rather than interpreted as a regex pattern.
 * For the single-match case the split has exactly two parts, so join yields exactly one replacement.
 */
export function planStrEdit(
  text: string,
  oldStr: string,
  newStr: string,
  replaceAll = false,
): { next: string; matches: number } {
  if (!oldStr) throw new Error('edit_file FAILED: old_str is empty. Provide a non-empty anchor string.');
  const parts = text.split(oldStr);
  const matches = parts.length - 1;
  if (matches === 0) {
    throw new Error(
      'edit_file FAILED: old_str not found. It must match the file byte-for-byte (check whitespace/indentation).',
    );
  }
  if (matches > 1 && !replaceAll) {
    throw new Error(
      `edit_file REFUSED: old_str matches ${matches} times. An ambiguous patch is never applied silently. ` +
        'Extend old_str until it is unique, or pass replace_all=true.',
    );
  }
  return { next: parts.join(newStr), matches };
}

/** PURE optimistic-concurrency guard. Throws if expected_sha is set and differs from the current sha. */
export function assertShaMatch(path: string, currentSha: string, expectedSha?: string): void {
  if (expectedSha && currentSha !== expectedSha) {
    throw new Error(
      `edit_file REFUSED: ${path} has changed (expected sha ${expectedSha.slice(0, 12)}, found ${currentSha.slice(0, 12)}). ` +
        'Re-read the file and rebuild your patch.',
    );
  }
}

/** PURE dry-run preview: a compact unified-diff-style view of just the changed region (bounded). */
export function makeEditPreview(text: string, oldStr: string, newStr: string): string {
  const CTX = 2, MAX = 1200;
  const idx = text.indexOf(oldStr);
  const clip = (s: string) => (s.length > MAX ? s.slice(0, MAX) + `\n… (+${s.length - MAX} more chars)` : s);
  const lines: string[] = [];
  if (idx >= 0) {
    const ctxBefore = text.slice(0, idx).split('\n').slice(-CTX - 1, -1);
    for (const l of ctxBefore) lines.push('  ' + l);
  }
  for (const l of clip(oldStr).split('\n')) lines.push('- ' + l);
  for (const l of clip(newStr).split('\n')) lines.push('+ ' + l);
  return lines.join('\n');
}
