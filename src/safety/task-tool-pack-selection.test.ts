import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EXTERNAL_READONLY_TOOLSET } from '../tools/registry.js';
import {
  parseTaskClassHeader,
  selectTaskScopedToolPack,
} from './task-tool-pack-selection.js';

const BASELINE = [...EXTERNAL_READONLY_TOOLSET];
const CTO_ALLOWLIST = new Set([
  ...BASELINE,
  'github_get_file_contents',
  'github_create_branch',
  'github_push_files',
  'github_create_pull_request',
  'github_merge_pull_request',
  'kb_search_privileged',
  'legal_blob_get',
  'memory_write',
  'stripe_create_refund',
]);

function select(taskClass: unknown, authenticatedSeat: string, seatAllowlist: ReadonlySet<string>) {
  return selectTaskScopedToolPack({
    taskClass,
    authenticatedSeat,
    authenticatedSeatAllowlist: seatAllowlist,
    readOnlyBaseline: BASELINE,
  });
}

test('missing, repeated, malformed, and unknown headers resolve to the read-only class', () => {
  for (const raw of [undefined, null, 17, ['engineering'], '', '   ', 'privileged', 'engineering,read_only']) {
    assert.equal(parseTaskClassHeader(raw), 'read_only');
  }
  assert.equal(parseTaskClassHeader(' read_only '), 'read_only');
  assert.equal(parseTaskClassHeader('Engineering'), 'engineering');
});

test('unknown and invalid classes expose only the seat-filtered read-only baseline', () => {
  const seatAllowlist = new Set([...BASELINE, 'github_create_branch']);
  for (const taskClass of [undefined, null, 17, '', 'unknown', 'privileged']) {
    assert.deepEqual(select(taskClass, 'cto', seatAllowlist), [...BASELINE].sort());
  }
});

test('engineering selection is a deterministic intersection and cannot widen the authenticated seat', () => {
  const allowed = select('engineering', 'cto', CTO_ALLOWLIST);
  assert.deepEqual(allowed, [...allowed].sort());
  assert.ok(allowed.includes('github_create_branch'));
  assert.ok(allowed.includes('github_push_files'));
  assert.ok(!allowed.includes('github_merge_pull_request'), 'merge is outside the bounded engineering pack');
  assert.ok(!allowed.includes('kb_search_privileged'));
  assert.ok(!allowed.includes('legal_blob_get'));
  assert.ok(!allowed.includes('memory_write'));
  assert.ok(!allowed.includes('stripe_create_refund'));
  assert.ok(allowed.every((name) => CTO_ALLOWLIST.has(name)));

  const narrowerSeat = new Set([...BASELINE, 'github_push_files']);
  assert.ok(!select('engineering', 'cto', narrowerSeat).includes('github_create_branch'));
});

test('engineering tools do not leak into a different authenticated seat', () => {
  const cooAllowlist = new Set([...BASELINE, 'github_create_branch', 'intercom_contact_search']);
  const coo = select('engineering', 'coo', cooAllowlist);
  assert.deepEqual(coo, [...BASELINE].sort());
  assert.ok(!coo.includes('github_create_branch'));
  assert.ok(!coo.includes('intercom_contact_search'));
});
