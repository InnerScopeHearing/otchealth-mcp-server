import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * REPO GUARD: no credential-shaped value may be committed, anywhere, in any file.
 *
 * This exists because of a real miss on 2026-08-16. `infra/aws/data/task-definitions-jobs.json`
 * was a verbatim capture of live ECS task definitions, and two of the captured environment
 * variables were full AWS SigV4 pre-signed S3 URLs, each carrying an access key id and a
 * signature. A heuristic scan run over the same branch did not flag them, because that scan
 * checked whether a VALUE STARTED WITH a known prefix (AKIA, sk-, ghp_, xox). Here the key sat
 * in the middle of a longer URL, as `...?X-Amz-Credential=AKIA.../20260814/us-east-1/...`, so a
 * prefix test never saw it.
 *
 * That is the whole point of this guard: it matches ANYWHERE in the file, never at a boundary.
 * A credential does not stop being a credential because it is embedded in a query string.
 *
 * Two design choices worth keeping:
 *
 * 1. It scans `git ls-files`, not just `src/`. The offending file was infrastructure data, not
 *    TypeScript. A guard scoped to source code would have been just as blind as the prefix scan.
 *
 * 2. The known-positive test below proves the patterns still DETECT. Without it, someone could
 *    loosen a regex to silence a failure and this file would keep passing while checking nothing,
 *    which is the same silent-success failure mode the fleet has been bitten by repeatedly.
 *
 * If a scan fails: remove the value and rotate it if it was ever live. Do not add an allow-list
 * entry to make the failure go away, and do not narrow a pattern. The allow-list is only for a
 * fixture that is provably not a real credential, and it must say why.
 */

const REPO_ROOT = new URL('../..', import.meta.url).pathname;
const NUL = String.fromCharCode(0);

/**
 * Each pattern requires enough entropy-bearing body to distinguish a real credential from a
 * placeholder. `-----BEGIN PRIVATE KEY-----\nMIIC...fakekeycontent...` does not match, because
 * the body must be unbroken base64; that is deliberate, so obvious test fixtures stay legal.
 */
const CREDENTIAL_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = Object.freeze([
  ['aws-access-key-id', /AKIA[0-9A-Z]{16}/],
  ['aws-presigned-signature', /X-Amz-Signature=[A-Fa-f0-9]{32,}/],
  ['azure-storage-account-key', /AccountKey=[A-Za-z0-9+/=]{40,}/],
  ['azure-sas-signature', /[?&]sig=[A-Za-z0-9%+/=]{40,}/],
  ['private-key-pem', /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----[A-Za-z0-9+/=\s]{40,}/],
  ['github-token', /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}\b/],
  ['slack-token', /\bxox[baprs]-[A-Za-z0-9-]{10,}/],
  ['openai-key', /\bsk-[A-Za-z0-9_-]{32,}/],
] as const);

/** Files exempt from a specific pattern, each with the reason it is provably not a credential. */
const ALLOWED: Readonly<Record<string, string>> = Object.freeze({
  // Intentionally empty. Adding an entry is a deliberate, reviewed decision, not a way to get green.
});

function trackedTextFiles(): Array<{ path: string; text: string }> {
  const listing = execFileSync('git', ['ls-files', '-z'], { cwd: REPO_ROOT, maxBuffer: 1e9 })
    .toString()
    .split(NUL)
    .filter(Boolean);

  const out: Array<{ path: string; text: string }> = [];
  for (const rel of listing) {
    let text: string;
    try {
      text = readFileSync(join(REPO_ROOT, rel), 'utf8');
    } catch {
      continue; // deleted, submodule, or unreadable
    }
    if (text.includes(NUL)) continue; // binary
    out.push({ path: rel, text });
  }
  return out;
}

test('THE SHOWSTOPPER: no committed file contains a credential-shaped value', () => {
  const files = trackedTextFiles();

  // A scan that silently scans nothing is worse than no scan. Anchor on a real floor.
  assert.ok(
    files.length > 100,
    `expected to scan the repository, only found ${files.length} readable tracked text files`,
  );

  const findings: string[] = [];
  for (const { path, text } of files) {
    for (const [name, pattern] of CREDENTIAL_PATTERNS) {
      if (ALLOWED[`${path}:${name}`]) continue;
      // Report EVERY occurrence, not just the first. Reporting one at a time turns a two-line
      // problem into two rounds of fix-and-rerun, and invites "I fixed the one it named" when a
      // second identical value is still sitting three lines below it.
      for (const match of text.matchAll(new RegExp(pattern.source, 'g'))) {
        const line = text.slice(0, match.index ?? 0).split('\n').length;
        findings.push(`${path}:${line} matches ${name}`);
      }
    }
  }

  assert.deepEqual(
    findings,
    [],
    `credential-shaped values are committed:\n  ${findings.join('\n  ')}\n` +
      'Remove the value (a placeholder or an SSM parameter reference), and rotate it if it was ever live.',
  );
});

test('the patterns actually detect: a known-positive sample trips every pattern', () => {
  // Built by concatenation on purpose, so this file contains no credential-shaped literal of its
  // own and is therefore subject to the same scan as everything else, with no blind spot.
  const A = 'AKIA' + 'ABCDEFGHIJKLMNOP';
  const HEX = 'a1b2c3d4'.repeat(8);
  const B64 = 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVphYmNkZWZnaGlqa2xtbm9w';

  const samples: Record<string, string> = {
    'aws-access-key-id': `https://b.s3.amazonaws.com/k?X-Amz-Credential=${A}%2F20260814%2Fus-east-1`,
    'aws-presigned-signature': `https://b.s3.amazonaws.com/k?X-Amz-Signature=${HEX}`,
    'azure-storage-account-key': `DefaultEndpointsProtocol=https;AccountKey=${B64};`,
    'azure-sas-signature': `https://x.blob.core.windows.net/c/b?sv=2021&sig=${B64}`,
    'private-key-pem': `-----BEGIN PRIVATE KEY-----\n${B64}\n-----END PRIVATE KEY-----`,
    'github-token': 'gh' + 'p_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8',
    'slack-token': 'xo' + 'xb-' + '123456789012-abcdefghijkl',
    'openai-key': 'sk' + '-' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6',
  };

  for (const [name, pattern] of CREDENTIAL_PATTERNS) {
    const sample = samples[name];
    assert.ok(sample, `no known-positive sample defined for pattern ${name}`);
    assert.match(sample, pattern, `pattern ${name} no longer detects its own known-positive sample`);
  }
});

test('the patterns tolerate obvious placeholders, so fixtures do not force an allow-list', () => {
  const placeholders = [
    '-----BEGIN PRIVATE KEY-----\\nMIIC...fakekeycontent...\\n-----END PRIVATE KEY-----',
    'https://files.example.com/logo.png?X-Amz-Signature=abc',
    'REDACTED_PRESIGNED_URL(s3://bucket/key.dump)',
    'AKIA_PLACEHOLDER',
    'valueFrom: arn:aws:ssm:us-east-1:900915535335:parameter/otchealth/aws-pg-host',
  ];

  for (const placeholder of placeholders) {
    for (const [name, pattern] of CREDENTIAL_PATTERNS) {
      assert.doesNotMatch(
        placeholder,
        pattern,
        `pattern ${name} false-positives on a placeholder: ${placeholder.slice(0, 48)}`,
      );
    }
  }
});
