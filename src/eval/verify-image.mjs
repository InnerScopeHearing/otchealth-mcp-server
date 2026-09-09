import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const command = (name, args) => {
  const result = spawnSync(name, args, { maxBuffer: 8 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`${name} failed; command output suppressed`);
  return result.stdout;
};
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

// Copies files from a stopped container. Does not run the image or evaluator.
export function verifyImage({ repo, source, digest, indexDigest }, execute = command) {
  if (!/^[a-f0-9]{40}$/.test(source ?? '')
      || !/^sha256:[a-f0-9]{64}$/.test(digest ?? '')
      || !/^sha256:[a-f0-9]{64}$/.test(indexDigest ?? '')) throw new Error('Invalid immutable identity');
  const image = `900915535335.dkr.ecr.us-east-1.amazonaws.com/otchealth-mcp-gateway@${digest}`;
  const directory = mkdtempSync(join(tmpdir(), 'eval-image-'));
  let container;
  try {
    execute('docker', ['pull', '--platform', 'linux/arm64', image]);
    container = execute('docker', ['create', '--platform', 'linux/arm64', '--entrypoint', '/bin/true', image]).toString().trim();
    if (!/^[a-f0-9]{64}$/.test(container)) throw new Error('Invalid container identifier');
    const files = [];
    for (const file of ['eval-runner.mjs', 'eval-scoring.mjs', 'eval-baseline.mjs', 'eval-transport.mjs', 'redact.mjs', 'cases.json']) {
      execute('docker', ['cp', `${container}:/app/eval/${file}`, join(directory, file)]);
      const expected = sha256(execute('git', ['-C', repo, 'show', `${source}:src/eval/${file}`]));
      const actual = sha256(readFileSync(join(directory, file)));
      if (actual !== expected) throw new Error(`Image/source mismatch: ${file}`);
      files.push({ file, sha256: actual });
    }
    return { source, indexDigest, platformDigest: digest, platform: 'linux/arm64', files, match: true,
      scope: 'Four evaluator files only; no runtime acceptance or cryptographic build attestation.' };
  } finally {
    try {
      if (/^[a-f0-9]{64}$/.test(container ?? '')) execute('docker', ['rm', container]);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [repo, source, digest, indexDigest, receiptPath] = process.argv.slice(2);
  const receipt = verifyImage({ repo, source, digest, indexDigest });
  writeFileSync(receiptPath, JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify(receipt, null, 2));
}
