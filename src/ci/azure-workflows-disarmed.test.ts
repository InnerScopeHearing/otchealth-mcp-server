import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Locks two properties that were each violated in production, in ways that presented as fine.
//
// (1) THE DISARM MUST STAY DISARMED. Azure subscription 55c84f6b-ef90-4259-a58b-50835cc4cab4 was
//     permanently deleted, so every workflow below can only fail. #247 disarmed three of them and
//     MISSED add-oauth-client.yml -- the one that mints OAuth lane credentials into the live
//     OAUTH_CLIENTS registry. A privileged-credential workflow left presenting as live is the worst
//     one to miss, so the set is asserted explicitly rather than left to whoever runs the next sweep.
//
//     Note the assertion shape: an ALLOW-LIST of permitted triggers, not a deny-list of forbidden
//     ones. A deny-list ("must not contain push:") passes happily when someone re-arms via
//     schedule:, workflow_call:, repository_dispatch: or pull_request:, which is a test that goes
//     green for a reason unrelated to the property it claims to check.
//
// (2) NO WORKFLOW MAY IMPLY AN APPROVAL GATE THAT IS NOT CONFIGURED. Verified live against the
//     GitHub API on 2026-08-18: this repo's `production` environment has `protection_rules: []` and
//     `can_admins_bypass: true` -- no required reviewers, no self-review prevention. deploy.yml
//     nonetheless carried the comment "human approval gate; reviewer must differ from the release
//     opener". Both halves were false. `environment: production` is still REQUIRED here (the OIDC
//     federated credential trusts only the subject `...:environment:production`), so the fix is to
//     the claim, never to the declaration. Any file that declares the environment must also carry
//     the note saying what it does and does not buy.

const AZURE_WORKFLOWS = [
  'deploy.yml',
  'digest-drift.yml',
  'revision-gc.yml',
  'add-oauth-client.yml',
] as const;

const ALLOWED_TRIGGERS = new Set(['workflow_dispatch']);

/**
 * Reconstitute prose sentences from a workflow's comments. Comment blocks are hard-wrapped, so a
 * single assertion routinely spans several lines and a per-line check reads half a claim. Blank
 * comment lines end a paragraph; trailing inline comments are treated as standalone sentences.
 */
function commentSentences(src: string): string[] {
  const paragraphs: string[] = [];
  let current: string[] = [];
  const flush = () => {
    if (current.length) paragraphs.push(current.join(' '));
    current = [];
  };
  for (const line of src.split('\n')) {
    const full = /^\s*#\s?(.*)$/.exec(line);
    if (full) {
      if (full[1].trim() === '') flush();
      else current.push(full[1].trim());
      continue;
    }
    flush();
    const inline = /\s#\s?(.+)$/.exec(line);
    if (inline) paragraphs.push(inline[1].trim());
  }
  flush();
  return paragraphs.flatMap((p) => p.split(/(?<=[.;])\s+/)).filter((x) => x.trim() !== '');
}

function wf(name: string): string {
  return readFileSync(join(process.cwd(), '.github', 'workflows', name), 'utf8');
}

/** Top-level keys of the `on:` block, by indentation, without a YAML dependency. */
function triggersOf(src: string): string[] {
  const lines = src.split('\n');
  const start = lines.findIndex((l) => /^on:\s*$/.test(l));
  assert.notEqual(start, -1, 'expected a block-form `on:` mapping');
  const out: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break; // dedented back to top level: block over
    const m = /^ {2}([A-Za-z_][A-Za-z0-9_]*):/.exec(line);
    if (m) out.push(m[1]);
  }
  return out;
}

for (const name of AZURE_WORKFLOWS) {
  test(`${name} still declares itself disarmed`, () => {
    assert.match(wf(name), /DISARMED 2026-08-18/, `${name} lost its disarm header`);
  });

  test(`${name} has no automatic trigger`, () => {
    const found = triggersOf(wf(name));
    const rogue = found.filter((t) => !ALLOWED_TRIGGERS.has(t));
    assert.deepEqual(rogue, [], `${name} re-armed via: ${rogue.join(', ')}`);
    assert.ok(found.length > 0, `${name} has no triggers at all`);
  });
}

test('add-oauth-client refuses before it can reach Azure/login', () => {
  const src = wf('add-oauth-client.yml');
  // Match the STEP, not any mention: `Azure/login` also appears in this file's header prose and in
  // the guard's own error text, both of which precede the real step. An earlier draft of this test
  // used a bare indexOf and compared against the header occurrence -- it would have reported the
  // ordering as broken while the ordering was fine, which is the same read-the-wrong-match failure
  // these workflows are being audited for.
  const refusal = src.indexOf('Refuse -- disarmed');
  const loginStep = /^\s*-\s*uses:\s*Azure\/login@/m.exec(src);
  assert.notEqual(refusal, -1, 'the refusal guard step is gone');
  assert.ok(loginStep, 'the Azure/login STEP vanished; re-check this assertion still means anything');
  const login = loginStep.index;
  assert.ok(
    refusal < login,
    'the refusal guard must come BEFORE Azure/login, or a dispatcher gets an obscure auth error ' +
      'instead of a named refusal, having already believed a credential was being minted',
  );
  assert.match(src, /exit 1/, 'the guard must actually fail, not merely print');
});

test('a workflow declaring `environment: production` must not imply an approval gate it lacks', () => {
  for (const name of [...AZURE_WORKFLOWS]) {
    const src = wf(name);
    if (!/^\s*environment:\s*production\s*(#.*)?$/m.test(src)) continue;
    assert.match(
      src,
      /protection_rules: \[\]/,
      `${name} declares environment: production but omits the note recording that it carries no ` +
        `required reviewers. Verified live 2026-08-18; re-verify before changing this.`,
    );
    // The rule is not "never mention an approval gate" -- the corrective note must mention one in
    // order to deny it, and a flat phrase ban flagged that very correction as the defect. Nor can
    // the check run per LINE: a claim's unit is a SENTENCE, and comment wrapping routinely puts the
    // negation on the line above the phrase it negates. So reconstitute sentences first, then judge.
    for (const sentence of commentSentences(src)) {
      if (!/approval gate|required reviewer/i.test(sentence)) continue;
      const negated = /\b(not|no|never|lacks|without|nor)\b/i.test(sentence);
      const aboutAnotherRepo = /flatstick/i.test(sentence);
      assert.ok(
        negated || aboutAnotherRepo,
        `${name} asserts an approval gate affirmatively about THIS repo: "${sentence.trim()}" -- ` +
          `its production environment has protection_rules: [] (verified live 2026-08-18), so the ` +
          `claim is false. Stating that a DIFFERENT repo has one is fine; name it explicitly.`,
      );
    }
  }
});
