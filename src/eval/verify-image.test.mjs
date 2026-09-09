import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { verifyImage } from './verify-image.mjs';
const identity = { repo: '.', source: 'a'.repeat(40), digest: `sha256:${'b'.repeat(64)}`, indexDigest: `sha256:${'c'.repeat(64)}` };
function fake(mismatch = false) {
  const calls = [];
  return { calls, execute(name, args) {
    calls.push([name, ...args]);
    if (name === 'git') return Buffer.from('synthetic source\n');
    if (args[0] === 'create') return Buffer.from('d'.repeat(64));
    if (args[0] === 'cp') writeFileSync(args[2], mismatch ? 'altered' : 'synthetic source\n');
    return Buffer.from('');
  } };
}
test('four file hashes verified using immutable image without running a container', () => {
  const f = fake();
  const receipt = verifyImage(identity, f.execute);
  assert.equal(receipt.match, true);
  assert.equal(receipt.files.length, 4);
  assert.ok(f.calls.filter(x => x[0] === 'docker').every(x => ['pull', 'create', 'cp', 'rm'].includes(x[1])));
  assert.ok(f.calls.some(x => x.includes(`900915535335.dkr.ecr.us-east-1.amazonaws.com/otchealth-mcp-gateway@${identity.digest}`)));
});
test('mismatch fails closed and removes stopped container', () => {
  const f = fake(true);
  assert.throws(() => verifyImage(identity, f.execute), /mismatch/);
  assert.equal(f.calls.at(-1)[1], 'rm');
});
test('mutable image identity rejected before commands', () => {
  const f = fake();
  assert.throws(() => verifyImage({ ...identity, digest: 'latest' }, f.execute), /identity/);
  assert.equal(f.calls.length, 0);
});
