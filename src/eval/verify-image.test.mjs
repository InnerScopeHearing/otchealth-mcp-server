import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { verifyImage } from './verify-image.mjs';
const identity = { repo: '.', source: 'a'.repeat(40), digest: `sha256:${'b'.repeat(64)}`, indexDigest: `sha256:${'c'.repeat(64)}` };
function fake({ mismatch = false, sourceType = 'commit', architecture = 'arm64', repoDigest = true, copiedNonRegular = false } = {}) {
  const calls = [];
  return { calls, execute(name, args) {
    calls.push([name, ...args]);
    if (name === 'git' && args.includes('-t')) return Buffer.from(sourceType);
    if (name === 'git') return Buffer.from('synthetic source\n');
    if (args[0] === 'image') return Buffer.from(JSON.stringify({ Os: 'linux', Architecture: architecture,
      RepoDigests: repoDigest ? [`900915535335.dkr.ecr.us-east-1.amazonaws.com/otchealth-mcp-gateway@${identity.digest}`] : [] }));
    if (args[0] === 'create') return Buffer.from('d'.repeat(64));
    if (args[0] === 'cp') {
      if (copiedNonRegular) mkdirSync(args[2]);
      else writeFileSync(args[2], mismatch ? 'altered' : 'synthetic source\n');
    }
    return Buffer.from('');
  } };
}
test('six runtime file hashes verified using immutable image without running a container', () => {
  const f = fake();
  const receipt = verifyImage(identity, f.execute);
  assert.equal(receipt.match, true);
  assert.equal(receipt.files.length, 6);
  assert.ok(f.calls.filter(x => x[0] === 'docker').every(x => ['pull', 'image', 'create', 'cp', 'rm'].includes(x[1])));
  assert.ok(f.calls.some(x => x.includes(`900915535335.dkr.ecr.us-east-1.amazonaws.com/otchealth-mcp-gateway@${identity.digest}`)));
});
test('mismatch fails closed and removes stopped container', () => {
  const f = fake({ mismatch: true });
  assert.throws(() => verifyImage(identity, f.execute), /mismatch/);
  assert.equal(f.calls.at(-1)[1], 'rm');
});
test('mutable image identity rejected before commands', () => {
  const f = fake();
  assert.throws(() => verifyImage({ ...identity, digest: 'latest' }, f.execute), /identity/);
  assert.equal(f.calls.length, 0);
});
test('tree source, wrong platform or mismatched digest are rejected before container creation', () => {
  for (const options of [{ sourceType: 'tree' }, { architecture: 'amd64' }, { repoDigest: false }]) {
    const f = fake(options);
    assert.throws(() => verifyImage(identity, f.execute), /commit|ARM64 digest/);
    assert.ok(!f.calls.some(x => x[0] === 'docker' && x[1] === 'create'));
  }
});
test('non-regular copied image path fails closed and removes stopped container', () => {
  const f = fake({ copiedNonRegular: true });
  assert.throws(() => verifyImage(identity, f.execute), /Non-regular extracted path/);
  assert.equal(f.calls.at(-1)[1], 'rm');
});
