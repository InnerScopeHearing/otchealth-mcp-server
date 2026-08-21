import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error -- redact.mjs is plain ESM JS (the eval harness runs uncompiled), so it has no
// type declarations. Importing it here is deliberate: this test must exercise the SAME code the
// harness runs, not a TypeScript re-implementation of it.
import { redactSecrets } from './redact.mjs';

// Regression suite for a real leak. The scheduled eval job (otchealth-job-otchealth-mcp-eval) pointed
// at a dead host, so every case timed out; Node's execFile error message embeds the full curl command
// line, and the harness printed and stored it. The gateway bearer went into CloudWatch daily.
//
// The realistic shape of the leak, reused across cases so each test exercises the actual failure
// rather than a convenient abstraction of it.
const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.aGVsbG8td29ybGQtdG9rZW4.c2lnbmF0dXJlLXZhbHVl';
const execFileFailure = (token: string) =>
  `Command failed: curl --silent --max-time 20 -H 'Authorization: Bearer ${token}' ` +
  `-H 'Content-Type: application/json' https://mcp.otchealth.app/mcp`;

test('redactSecrets: the configured token never survives an execFile error message', () => {
  const out = redactSecrets(new Error(execFileFailure(TOKEN)), TOKEN);
  assert.ok(!out.includes(TOKEN), 'the live token leaked through redaction');
  assert.match(out, /<REDACTED:GATEWAY_BEARER>/);
  // The surrounding diagnostic must survive, or the redactor has traded a leak for a blind spot.
  assert.match(out, /curl --silent/);
  assert.match(out, /mcp\.otchealth\.app/);
});

test('redactSecrets: an UNKNOWN bearer is masked by shape, not just the configured value', () => {
  // The case that matters most. If the token rotates, or a second credential appears, an
  // exact-value-only redactor silently stops redacting at exactly the moment it is needed.
  const rotated = 'a-completely-different-token-value-9f2b4c';
  const out = redactSecrets(new Error(execFileFailure(rotated)), TOKEN);
  assert.ok(!out.includes(rotated), 'a non-configured bearer leaked through');
  assert.match(out, /Bearer <REDACTED>/);
});

test('redactSecrets: accepts Errors, strings, and junk without throwing', () => {
  // This runs inside catch blocks and a top-level .catch(), so throwing here would convert a logged
  // failure into an unhandled crash -- turning a visible problem into a silent one.
  assert.equal(redactSecrets(`plain string with Bearer ${TOKEN}`, TOKEN).includes(TOKEN), false);
  assert.equal(redactSecrets(undefined, TOKEN), '');
  assert.equal(redactSecrets(null, TOKEN), '');
  assert.equal(redactSecrets({ message: `Bearer ${TOKEN}` }, TOKEN).includes(TOKEN), false);
  assert.doesNotThrow(() => redactSecrets(Symbol('x') as unknown, TOKEN));
});

test('redactSecrets: a short or empty secret is ignored rather than shredding the text', () => {
  // split/join on '' inserts the marker between every character, and a 1-2 char secret would mangle
  // ordinary prose. Either would destroy the diagnostic while looking like redaction worked.
  assert.equal(redactSecrets('connection refused', ''), 'connection refused');
  assert.equal(redactSecrets('connection refused', 'ab'), 'connection refused');
});

test('redactSecrets: preserves the specific marker instead of collapsing to the generic one', () => {
  // Ordering guarantee: the exact-value pass runs first so the output records WHICH credential
  // appeared. If the generic Bearer pass ran first it would swallow the token and the specific
  // marker would never appear, losing that signal.
  const out = redactSecrets(`Authorization: Bearer ${TOKEN}`, TOKEN);
  assert.match(out, /<REDACTED:GATEWAY_BEARER>/);
});

test('every log and note site in eval-runner.mjs routes through redactSecrets', async () => {
  // A behavioural guard on the CALL SITES, not on the redactor. redactSecrets being correct is
  // worthless if a future edit adds `console.log(err.message)` beside it, which is the exact shape
  // of the original bug.
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, 'eval-runner.mjs'), 'utf8');

  // Strip comments FIRST. A grep-the-source test that scans comments forbids documenting the very
  // bug it guards -- the prose explaining "we used to print err.message" would fail the assertion.
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/(^|[^:])\/\/.*$/, '$1'))
    .join('\n');

  const rawErrorInterpolation = /\$\{\s*(?:err|error)(?:\.message)?\s*\}/g;
  const offenders = [...code.matchAll(rawErrorInterpolation)].map((m) => m[0]);
  assert.deepEqual(
    offenders,
    [],
    `eval-runner.mjs interpolates a raw error (${offenders.join(', ')}); wrap it in redactSecrets()`,
  );

  // And the redactor must actually still be wired in, so the check above cannot pass vacuously by
  // someone deleting every error log entirely.
  assert.match(code, /import \{ redactSecrets \} from '\.\/redact\.mjs'/);
  assert.ok(
    (code.match(/redactSecrets\(/g) ?? []).length >= 5,
    'expected redactSecrets at every error/stderr output site in eval-runner.mjs',
  );
});
