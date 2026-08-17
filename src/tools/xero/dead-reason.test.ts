// The dead-org error must report the VENDOR'S error, never a guess at its cause.
//
// On 2026-08-17 every Xero org died at once. The gateway's message read
//   invalid_grant (chain consumed elsewhere or expired)
// but Xero returns a bare `invalid_grant`; the parenthetical was OUR hypothesis, baked into a log
// message long before the incident it was read during. The CFO reasonably took it as a finding,
// escalated a "second consumer is burning our rotating tokens" root cause, and had to retract it.
//
// `invalid_grant` is generic -- rotation-consumption, 60-day idle expiry, org-side disconnection,
// revocation, and loss of app standing all produce it. The cause cannot be read off the code, so a
// tool that asserts one manufactures a false lead. The remediation is identical whichever it was,
// so dropping the causal claim costs nothing and removes the wrong inference.
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('./client.ts', import.meta.url), 'utf8');
// Strip comments: this file DOCUMENTS the retired string verbatim in order to explain it, and a
// naive scan would match the explanation rather than the code. (Same trap that made an earlier
// guard in this fleet fail on fixed code.)
const code = src.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

test('the dead-org reason carries NO causal claim about why the grant is invalid', () => {
  assert.doesNotMatch(code, /chain consumed elsewhere/, 'the retired causal gloss must not return');
  for (const guess of ['consumed elsewhere', 'burned by', 'another consumer', 'stolen', 'race']) {
    assert.doesNotMatch(code, new RegExp(`deadReason[^;]*${guess}`, 'i'), `deadReason must not assert "${guess}"`);
  }
});

test('the dead-org reason still names the raw vendor error, so it stays diagnosable', () => {
  assert.match(code, /deadReason\s*=\s*`invalid_grant/, 'must report invalid_grant verbatim');
  assert.match(code, /cause not determinable from this code/, 'must say plainly that the cause is not knowable here');
});

test('the remediation instruction is unchanged and still actionable', () => {
  // Neutralising the cause must not weaken the FIX the operator needs. The per-org secret name and
  // the automatic re-bootstrap are the parts that make this message useful.
  assert.match(code, /needs re-consent/);
  assert.match(code, /XERO_RT_\$\{org\.toUpperCase\(\)\}/);
  assert.match(code, /re-bootstraps automatically/);
});
