import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildStepExcerpt,
  CI_LOG_MAX_EXCERPT_BYTES,
  CI_LOG_MAX_FAILED_JOBS,
  CI_LOG_MAX_FAILED_STEPS_PER_JOB,
  CI_LOG_MAX_LINE_CHARS,
  CI_LOG_REDACTED,
  CI_LOG_TAIL_LINES,
  entryBudgetBytes,
  parseJobLog,
  readResponseTail,
  redactLine,
  redactLines,
  stepWindow,
} from './ci-log-excerpt.js';

// Every synthetic credential is assembled at runtime so no source line looks like a real secret.
const t = (...parts: string[]) => parts.join('');
const SECRETS: Record<string, string> = {
  githubToken: t('gh', 'p_', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'),
  githubPat: t('github_', 'pat_', '11AAAAAAA0abcdefghijklmnopqrstuv'),
  awsKeyId: t('AK', 'IA', 'IOSFODNN7EXAMPLE'),
  jwt: t('ey', 'Jhbgcixxxxxxxx', '.', 'eyJzdWIiOiJ4eHh4eHh4', '.', 'abcdefghijklmnop'),
  slack: t('xo', 'xb-', '1234567890-abcdefghij'),
  stripe: t('sk_', 'live_', 'abcdefghijklmnop1234'),
  google: t('AI', 'za', 'SyA1234567890abcdefghijklmnopqrstuv'),
  npm: t('npm_', 'abcdefghijklmnopqrstuvwxyz0123456789'),
  sendgrid: t('S', 'G.', 'abcdefghijklmnop', '.', 'qrstuvwxyz012345'),
};

test('redactLine removes every known token format', () => {
  for (const [name, secret] of Object.entries(SECRETS)) {
    const out = redactLine(`before ${secret} after`);
    assert.ok(!out.includes(secret), `${name} must be redacted: ${out}`);
    assert.ok(out.includes(CI_LOG_REDACTED), name);
    assert.ok(out.startsWith('before ') && out.endsWith(' after'), `${name} keeps surrounding text`);
  }
});

test('redactLine removes credential assignments, auth headers, URL credentials and signed-URL parameters', () => {
  const cases: Array<[string, string, string]> = [
    ['  GH_TOKEN: ***', 'GH_TOKEN: ' + CI_LOG_REDACTED, '***'],
    ['DB_PASSWORD=hunter2hunter2', 'DB_PASSWORD=' + CI_LOG_REDACTED, 'hunter2'],
    ['{"client_secret": "s3cr3t-value", "x": 1}', '"client_secret": ' + CI_LOG_REDACTED, 's3cr3t'],
    ['AWS_SECRET_ACCESS_KEY: wJalrXUtnFEMI', 'AWS_SECRET_ACCESS_KEY: ' + CI_LOG_REDACTED, 'wJalrXUtnFEMI'],
    ['Authorization: Bearer abcdefgh12345678', 'Authorization: ' + CI_LOG_REDACTED, 'abcdefgh12345678'],
    ['curl -H "X-Debug: Bearer abcdefgh12345678"', 'Bearer ' + CI_LOG_REDACTED, 'abcdefgh12345678'],
    ['connect postgres://admin:pa55word@db.internal:5432/app', 'postgres://' + CI_LOG_REDACTED + '@db.internal', 'pa55word'],
    ['GET https://blob.example.net/a/b.txt?se=2026&sig=Zm9vYmFy&sp=r', 'sig=' + CI_LOG_REDACTED, 'Zm9vYmFy'],
    ['https://x.example.net/y?token=abc123&z=1', 'token=' + CI_LOG_REDACTED, 'abc123'],
  ];
  for (const [input, mustContain, mustNotContain] of cases) {
    const out = redactLine(input);
    assert.ok(out.includes(mustContain), `${input} -> ${out}`);
    assert.ok(!out.includes(mustNotContain), `${input} -> ${out}`);
  }
  // Redaction is idempotent.
  for (const [input] of cases) assert.equal(redactLine(redactLine(input)), redactLine(input));
});

test('redactLine catches long mixed-case blobs but leaves SHAs, digests, paths and plain text alone', () => {
  const blob = 'Zm9vYmFyQmF6UXV4MTIzNDU2Nzg5MEFiQ2RFZkdoSWpLbE1u';
  assert.ok(blob.length >= 40);
  assert.equal(redactLine(`key ${blob} end`), `key ${CI_LOG_REDACTED} end`);
  const keep = [
    'commit 0534693c5b1dfef5478d6e908fcb756ed3b906ed',
    'digest sha256:b1d4cc10aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'see https://github.com/InnerScopeHearing/otchealth-mcp-server/actions/runs/37573457809/job/110203232',
    'FAIL src/tools/github/workflow-run-failed-log-excerpt.test.ts > rejects non-CTO callers',
    '##[error]Process completed with exit code 1.',
    'Error: expected 3 to equal 4 at node:internal/process/task_queues:95:5',
    'PWD=/home/runner/work/otchealth-mcp-server/otchealth-mcp-server',
  ];
  for (const line of keep) assert.equal(redactLine(line), line);
});

test('redactLines drops private-key blocks whole, removes blank lines and caps line length', () => {
  const out = redactLines([
    'before',
    '',
    '   ',
    '-----BEGIN RSA PRIVATE KEY-----',
    'MIIEowIBAAKCAQEAx',
    'second body line',
    '-----END RSA PRIVATE KEY-----',
    'after',
    'y'.repeat(CI_LOG_MAX_LINE_CHARS + 200),
  ]);
  assert.deepEqual(out.slice(0, 3), ['before', '[REDACTED PRIVATE KEY BLOCK]', 'after']);
  assert.equal(out.length, 4);
  assert.ok((out[3] as string).startsWith('y'.repeat(CI_LOG_MAX_LINE_CHARS)));
  assert.ok((out[3] as string).endsWith('...[truncated]'));
  assert.ok(!out.join('\n').includes('MIIEow'));
  // An unterminated block fails closed: everything after BEGIN is dropped.
  assert.deepEqual(redactLines(['a', '-----BEGIN PRIVATE KEY-----', 'b', 'c']), ['a', '[REDACTED PRIVATE KEY BLOCK]']);
});

test('parseJobLog strips timestamps, ANSI codes, BOM and control characters and carries timestamps forward', () => {
  const lines = parseJobLog(
    '﻿2026-10-06T21:00:00.1234567Z \u001b[31mred\u001b[0m text\r\n' +
    'continuation without a timestamp\n' +
    '2026-10-06T21:00:02Z next\u0007line',
  );
  assert.equal(lines.length, 3);
  assert.equal(lines[0]?.text, 'red text');
  assert.equal(lines[0]?.ts, Date.parse('2026-10-06T21:00:00.123Z'));
  assert.equal(lines[1]?.text, 'continuation without a timestamp');
  assert.equal(lines[1]?.ts, lines[0]?.ts);
  assert.equal(lines[2]?.text, 'nextline');
  assert.equal(lines[2]?.ts, Date.parse('2026-10-06T21:00:02.000Z'));
});

const LOG = parseJobLog([
  '2026-10-06T21:00:00.1000000Z ##[group]Run actions/checkout@v4',
  '2026-10-06T21:00:04.9000000Z checkout done',
  '2026-10-06T21:00:05.0000000Z ##[group]Run npm test',
  '2026-10-06T21:00:06.5000000Z FAIL src/foo.test.ts',
  '2026-10-06T21:00:07.4000000Z ##[error]Process completed with exit code 1.',
  '2026-10-06T21:00:08.0000000Z Post job cleanup.',
].join('\n'));
const FAILED_STEP = stepWindow({ number: 2, name: 'Run tests', started_at: '2026-10-06T21:00:05.000Z', completed_at: '2026-10-06T21:00:07.000Z' });

test('buildStepExcerpt selects lines by step timestamp window, inclusive of the final second', () => {
  const entry = buildStepExcerpt(LOG, FAILED_STEP, 10_000);
  assert.equal(entry.attribution, 'step_window');
  assert.equal(entry.step_number, 2);
  assert.equal(entry.step_name, 'Run tests');
  assert.equal(entry.truncated, false);
  assert.deepEqual(entry.excerpt.split('\n'), [
    '##[group]Run npm test',
    'FAIL src/foo.test.ts',
    '##[error]Process completed with exit code 1.',
  ]);
  assert.equal(entry.line_count, 3);
});

test('buildStepExcerpt falls back to the job tail when the step has no usable window or no lines in it', () => {
  for (const step of [null, stepWindow({ number: 9, name: 'No times' }), stepWindow({ name: 'Elsewhere', started_at: '2030-01-01T00:00:00Z', completed_at: '2030-01-01T00:00:01Z' })]) {
    const entry = buildStepExcerpt(LOG, step, 10_000);
    assert.equal(entry.attribution, 'job_tail');
    assert.equal(entry.line_count, 6);
    assert.ok(entry.excerpt.endsWith('Post job cleanup.'));
  }
});

test('buildStepExcerpt keeps only the newest lines: 200-line cap, byte budget, oldest dropped first', () => {
  const many = parseJobLog(Array.from({ length: 500 }, (_, i) => `2026-10-06T21:00:00.000Z line-${i}`).join('\n'));
  const capped = buildStepExcerpt(many, null, 1_000_000);
  assert.equal(capped.line_count, CI_LOG_TAIL_LINES);
  assert.equal(capped.truncated, true);
  assert.ok(capped.excerpt.startsWith('line-300\n') && capped.excerpt.endsWith('line-499'));

  const budgeted = buildStepExcerpt(many, null, 100);
  assert.ok(Buffer.byteLength(budgeted.excerpt, 'utf8') <= 100);
  assert.equal(budgeted.truncated, true);
  assert.ok(budgeted.excerpt.endsWith('line-499'));
  assert.ok(!budgeted.excerpt.includes('line-300'));
});

test('worst case: every failed step of every failed job together stays within the total excerpt cap', () => {
  const entries = CI_LOG_MAX_FAILED_JOBS * CI_LOG_MAX_FAILED_STEPS_PER_JOB;
  const budget = entryBudgetBytes(entries);
  assert.ok(budget * entries <= CI_LOG_MAX_EXCERPT_BYTES, `${budget} x ${entries}`);
  const huge = parseJobLog(Array.from({ length: 5_000 }, (_, i) => `2026-10-06T21:00:00.000Z ${'x'.repeat(400)} ${i}`).join('\n'));
  let total = 0;
  for (let i = 0; i < entries; i += 1) total += Buffer.byteLength(buildStepExcerpt(huge, null, budget).excerpt, 'utf8');
  assert.ok(total <= CI_LOG_MAX_EXCERPT_BYTES, `total ${total}`);
  assert.equal(entryBudgetBytes(1), CI_LOG_MAX_EXCERPT_BYTES);
});

function streamOf(chunks: Uint8Array[], neverEnd = false): Response {
  let i = 0;
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(chunks[i++] as Uint8Array);
      else if (!neverEnd) controller.close();
      else return new Promise(() => undefined);
    },
    cancel() { i = Number.MAX_SAFE_INTEGER; },
  }));
}

test('readResponseTail keeps only the newest bytes and reports head truncation', async () => {
  const small = await readResponseTail(streamOf([Buffer.from('hello '), Buffer.from('world')]), 1_000, 10_000, 1_000);
  assert.equal(small.bytes.toString('utf8'), 'hello world');
  assert.equal(small.headTruncated, false);

  const chunks = Array.from({ length: 50 }, (_, i) => Buffer.from(String(i % 10).repeat(100)));
  const big = await readResponseTail(streamOf(chunks), 1_000, 100_000, 1_000);
  assert.equal(big.bytes.length, 1_000);
  assert.equal(big.headTruncated, true);
  assert.equal(big.bytes.toString('utf8'), chunks.slice(40).map((c) => c.toString('utf8')).join(''));
});

test('readResponseTail fails on a body over the hard cap or one that never finishes', async () => {
  const chunks = Array.from({ length: 10 }, () => Buffer.alloc(100, 97));
  await assert.rejects(readResponseTail(streamOf(chunks), 200, 500, 1_000), { message: 'response too large' });
  await assert.rejects(readResponseTail(streamOf([Buffer.from('partial')], true), 200, 500, 50), { message: 'response body timed out' });
});
