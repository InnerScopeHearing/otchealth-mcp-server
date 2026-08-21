/**
 * Secret redaction for the eval harness's log and artifact output.
 *
 * WHY THIS EXISTS. curl takes its headers as ARGV, so `-H 'Authorization: Bearer <token>'` is part
 * of the command line. When execFile rejects (a timeout, a non-zero exit), Node builds an Error
 * whose `.message` embeds the ENTIRE command it tried to run -- token included. The harness printed
 * those messages straight to stdout and also stored them in each case's `note`, which is persisted
 * into the baseline JSON. So a failing eval wrote the live gateway bearer to CloudWatch once per
 * case, and into an artifact on disk.
 *
 * That is exactly what happened: the scheduled job pointed at a dead host, every case timed out, and
 * each timeout logged the token. It ran that way daily and nothing flagged it, because from the
 * outside it just looked like a failing test.
 *
 * Redacting at the point of OUTPUT rather than trying to keep the value off argv is deliberate. curl
 * has no way to accept a header without it appearing in the process arguments, so the only boundary
 * that can actually hold is everything we print or store.
 *
 * This lives in its own module purely so it is testable: eval-runner.mjs exits at import time when
 * GATEWAY_BEARER is unset and runs main() as a side effect, so a test cannot import it.
 */

/**
 * Two independent patterns are applied, and the second is the one that matters most.
 *
 * The exact-value pass catches the credential we know about. The `Bearer <...>` shape pass catches
 * one we do not: a rotated token, a second credential added later, a value supplied by a caller
 * rather than the environment. A redactor that only knows its own configured secret fails silently
 * the moment the thing being leaked is a different secret, which is precisely when it is needed.
 *
 * Order matters. The exact pass runs first so its output is the more specific, more debuggable
 * `<REDACTED:GATEWAY_BEARER>` marker (you can tell WHICH credential appeared) rather than the
 * generic one. Once replaced, that marker no longer matches the Bearer shape, so it survives.
 *
 * @param {unknown} value  An Error, a string, or anything stringifiable.
 * @param {string} [secret] The known credential. Defaults to the harness's own env var.
 * @returns {string} The text with credentials masked. Never throws.
 */
export function redactSecrets(value, secret = process.env.GATEWAY_BEARER ?? '') {
  let text;
  if (typeof value === 'string') {
    text = value;
  } else {
    // Prefer .message over String(err): String(err) on an Error yields "Error: <message>", and on a
    // plain object yields "[object Object]", losing the content we are trying to surface.
    text = String(value?.message ?? value ?? '');
  }

  // Guard against a short or empty secret. An empty string would make split/join insert the marker
  // between every character; a 1-2 char secret would shred ordinary prose. Neither is a redaction.
  if (secret && secret.length >= 8) {
    text = text.split(secret).join('<REDACTED:GATEWAY_BEARER>');
  }

  return text.replace(/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer <REDACTED>');
}
