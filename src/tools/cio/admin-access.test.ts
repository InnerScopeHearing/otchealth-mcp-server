import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  CIO_ADMIN_DATA_LANES,
  CIO_ADMIN_READ_TOOLS,
  CIO_ADMIN_WRITE_TOOLS,
  isCioAdminToolAllowed,
} from './admin-access.js';
import { requiredRoleFor, roleAllows } from '../../catalog/governance.js';
import { isToolInLaneAllowlist } from '../../config/lane-toolsets.js';
import { redactCioAdminInputForLog, redactCioAuditPayload } from './admin-redaction.js';

test('Customer.io administrative surface is fixed at exactly 20 reads and 22 bounded writes', () => {
  assert.equal(CIO_ADMIN_READ_TOOLS.length, 20);
  assert.equal(CIO_ADMIN_WRITE_TOOLS.length, 22);
  assert.equal(new Set([...CIO_ADMIN_READ_TOOLS, ...CIO_ADMIN_WRITE_TOOLS]).size, 42);
  for (const name of CIO_ADMIN_READ_TOOLS) assert.match(name, /^cio_admin_read_/);
  for (const name of CIO_ADMIN_WRITE_TOOLS) assert.match(name, /^cio_admin_write_/);
});

test('in-handler lane policy permits cto/cro/exec reads and previews but live writes only cto/exec', () => {
  const lanes = ['cto', 'cro', 'exec', 'coo', 'developer', 'cfo', 'clo', 'external-read', '', undefined, null];
  for (const tool of CIO_ADMIN_READ_TOOLS) {
    for (const lane of lanes) {
      assert.equal(
        isCioAdminToolAllowed(tool, lane, false),
        typeof lane === 'string' && (CIO_ADMIN_DATA_LANES as readonly string[]).includes(lane),
        `${tool}/${lane ?? '(null)'}`,
      );
    }
  }
  for (const tool of CIO_ADMIN_WRITE_TOOLS) {
    for (const lane of lanes) {
      const approvedLane = typeof lane === 'string' && (CIO_ADMIN_DATA_LANES as readonly string[]).includes(lane);
      assert.equal(isCioAdminToolAllowed(tool, lane, true), approvedLane, `${tool}/${lane ?? '(null)'}/dry`);
      assert.equal(isCioAdminToolAllowed(tool, lane, false), lane === 'cto' || lane === 'exec', `${tool}/${lane ?? '(null)'}/live`);
    }
  }
});

test('central governance mirrors the cto/cro/exec visibility model for every new tool', () => {
  for (const tool of [...CIO_ADMIN_READ_TOOLS, ...CIO_ADMIN_WRITE_TOOLS]) {
    const rule = requiredRoleFor(tool);
    assert.ok(rule, `${tool} requires a governance rule`);
    for (const lane of CIO_ADMIN_DATA_LANES) assert.equal(roleAllows(rule!.role, lane), true, `${tool} must allow ${lane}`);
    for (const lane of ['coo', 'developer', 'cfo', 'clo', 'external-read', '']) {
      assert.equal(roleAllows(rule!.role, lane), false, `${tool} must reject ${lane || '(empty)'}`);
    }
  }
});

test('CRO and CTO M365 seed allowlists include every admin tool while unrelated lanes do not', () => {
  for (const tool of [...CIO_ADMIN_READ_TOOLS, ...CIO_ADMIN_WRITE_TOOLS]) {
    assert.equal(isToolInLaneAllowlist('cro', tool), true, `cro must advertise ${tool}`);
    assert.equal(isToolInLaneAllowlist('cto', tool), true, `cto must advertise ${tool}`);
    assert.equal(isToolInLaneAllowlist('coo', tool), true, `coo cio_* wildcard still advertises ${tool}; in-handler gate remains authoritative`);
    assert.equal(isToolInLaneAllowlist('cfo', tool), false, `cfo must not advertise ${tool}`);
  }
});

test('every admin tool call-site has an explicit in-handler lane check and the fixed lists stay synchronized', () => {
  const source = readFileSync(new URL('./admin-tools.ts', import.meta.url), 'utf8');
  assert.match(source, /isCioAdminToolAllowed\(definition\.name, ctx\.callerAgent, false\)/);
  assert.match(source, /isCioAdminToolAllowed\(definition\.name, ctx\.callerAgent, ctx\.dryRun\)/);
  assert.match(source, /owner_approval_ref/);
  assert.match(source, /readDefinitions\.length !== CIO_ADMIN_READ_TOOLS\.length/);
  assert.match(source, /writeDefinitions\.length !== CIO_ADMIN_WRITE_TOOLS\.length/);
});

test('structured logging and audit projections fingerprint sensitive text instead of returning it', () => {
  const sensitive = 'customer@example.com SECRET BODY';
  const log = redactCioAdminInputForLog({
    owner_approval_ref: 'approval-123456',
    description: sensitive,
    payload: { email: 'customer@example.com' },
    goal_id: 5,
  });
  const serializedLog = JSON.stringify(log);
  assert.equal(serializedLog.includes(sensitive), false);
  assert.equal(serializedLog.includes('customer@example.com'), false);
  assert.match(serializedLog, /[a-f0-9]{64}/);
  assert.equal((log as Record<string, unknown>).goal_id, 5);

  const audit = redactCioAuditPayload({
    id: 9,
    action: 'updated',
    actor_email: 'customer@example.com',
    payload: { token: 'abc', body: sensitive },
  });
  const serializedAudit = JSON.stringify(audit);
  assert.equal(serializedAudit.includes('customer@example.com'), false);
  assert.equal(serializedAudit.includes(sensitive), false);
  assert.equal(serializedAudit.includes('"action":"updated"'), true);
});
