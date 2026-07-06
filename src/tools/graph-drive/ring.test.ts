import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isDriveFolderAllowed, roleOfFolder, rolesForLane } from './ring.js';

// Pins the own-role folder gate for graph_drive_*: a caller may only touch ITS OWN role's OneDrive
// exchange folders. One role must NEVER browse another role's folders by default.

test('roleOfFolder extracts the leading role token, case-insensitive', () => {
  assert.equal(roleOfFolder('CLO Outgoing'), 'clo');
  assert.equal(roleOfFolder('CTO Incoming/2026/sub'), 'cto');
  assert.equal(roleOfFolder('cfo processed'), 'cfo');
  assert.equal(roleOfFolder('/CLO Outgoing'), 'clo');
  assert.equal(roleOfFolder(''), null);
});

test('a caller may list/read/write ITS OWN role folders (all three exchange folders)', () => {
  for (const folder of ['CLO Outgoing', 'CLO Incoming', 'CLO Processed']) {
    assert.equal(isDriveFolderAllowed('clo', folder), true, `clo should reach ${folder}`);
  }
  for (const folder of ['CTO Outgoing', 'CTO Incoming', 'CTO Processed']) {
    assert.equal(isDriveFolderAllowed('cto', folder), true, `cto should reach ${folder}`);
  }
});

test('SAFETY-CRITICAL: one role cannot browse another role\'s folders by default', () => {
  assert.equal(isDriveFolderAllowed('cto', 'CLO Outgoing'), false, 'cto must not reach CLO folders');
  assert.equal(isDriveFolderAllowed('clo', 'CTO Incoming'), false, 'clo must not reach CTO folders');
  assert.equal(isDriveFolderAllowed('cfo', 'CLO Processed'), false, 'cfo must not reach CLO folders');
  assert.equal(isDriveFolderAllowed('developer', 'CTO Outgoing'), false, 'developer must not reach CTO folders');
});

test('clo-personal shares the CLO OneDrive exchange folders (not stranded), still cannot reach others', () => {
  assert.equal(isDriveFolderAllowed('clo-personal', 'CLO Incoming'), true);
  assert.equal(isDriveFolderAllowed('clo-personal', 'CFO Outgoing'), false);
});

test('exec (unified chief) owns every role folder', () => {
  for (const folder of ['CLO Outgoing', 'CTO Incoming', 'CFO Processed', 'COO Outgoing']) {
    assert.equal(isDriveFolderAllowed('exec', folder), true, `exec should reach ${folder}`);
  }
});

test('a caller with no lane identity is refused everywhere', () => {
  assert.equal(isDriveFolderAllowed('', 'CLO Outgoing'), false);
  assert.equal(isDriveFolderAllowed(undefined, 'CLO Outgoing'), false);
  assert.equal(isDriveFolderAllowed(null, 'CLO Outgoing'), false);
  assert.deepEqual(rolesForLane(''), []);
  assert.deepEqual(rolesForLane('unknown-lane'), []);
});

test('an unknown/blank folder is refused even for a valid lane', () => {
  assert.equal(isDriveFolderAllowed('clo', ''), false);
});
