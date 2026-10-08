/**
 * Who may use the AWS MCP bridge: the CTO lane over an OAuth session only, with an operator kill switch.
 * These are the unit tests for the access check itself; bridge.test.ts proves it runs before any AWS use.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AuthKind } from '../../server/request-context.js';
import {
  AWS_MCP_ACCEPTED_AUTH_KIND,
  AWS_MCP_BRIDGE_DISABLED_ENV,
  AwsMcpRefusalError,
  assertBridgeAccess,
  bridgeDisabled,
} from './access.js';

const ALL_KINDS: readonly AuthKind[] = ['oauth', 'descope', 'connector', 'copilot', 'copilot-dev', 'eval', 'm365', 'codex'];
const LANES = ['developer', 'cfo', 'clo', 'clo-personal', 'coo', 'cro', 'cpo', 'cco', 'exec', 'copilot-agent', 'external-read', 'wefunder-campaign-director', '', 'CTO', 'Cto', 'cto ', ' cto'];

function refusal(run: () => void): AwsMcpRefusalError {
  try {
    run();
  } catch (err) {
    assert.ok(err instanceof AwsMcpRefusalError, String(err));
    return err;
  }
  assert.fail('expected a refusal');
}

test('the accepted authentication kind is oauth, and only the cto lane over oauth passes (switch off)', () => {
  assert.equal(AWS_MCP_ACCEPTED_AUTH_KIND, 'oauth');
  assert.doesNotThrow(() => assertBridgeAccess({ callerAgent: 'cto', authKind: 'oauth' }, {}));
  for (const kind of ALL_KINDS) {
    for (const lane of ['cto', ...LANES]) {
      const passes = lane === 'cto' && kind === 'oauth';
      if (passes) continue;
      assert.throws(() => assertBridgeAccess({ callerAgent: lane, authKind: kind }, {}), AwsMcpRefusalError, `${lane} / ${kind}`);
    }
  }
});

test('a lane other than cto is refused as forbidden whatever the kind, and the message does not mention the credential', () => {
  for (const lane of LANES) {
    for (const kind of [...ALL_KINDS, undefined]) {
      const err = refusal(() => assertBridgeAccess({ callerAgent: lane, authKind: kind }, {}));
      assert.equal(err.code, 'aws_mcp_forbidden');
      assert.equal(err.message, 'aws_mcp_forbidden: the AWS bridge is available to the CTO lane only.');
    }
  }
});

test('the cto lane over any credential kind but oauth is refused, and the message names the kind and says no AWS request was made', () => {
  for (const kind of ALL_KINDS.filter((k) => k !== 'oauth')) {
    const err = refusal(() => assertBridgeAccess({ callerAgent: 'cto', authKind: kind }, {}));
    assert.equal(err.code, 'aws_mcp_forbidden');
    assert.equal(err.name, 'AwsMcpRefusalError');
    assert.equal(
      err.message,
      `aws_mcp_forbidden: the AWS bridge serves OAuth-authenticated CTO sessions only (the claude.ai connector), and this session authenticated with a "${kind}" credential, which is not an OAuth session. ` +
        'Static tokens and other credential types are refused. No AWS request was made.',
    );
  }
});

test('the cto lane with no recorded authentication kind is refused as not oauth', () => {
  const err = refusal(() => assertBridgeAccess({ callerAgent: 'cto' }, {}));
  assert.equal(err.code, 'aws_mcp_forbidden');
  assert.match(err.message, /this session does not record how it authenticated/);
  assert.match(err.message, /No AWS request was made\.$/);
  const explicit = refusal(() => assertBridgeAccess({ callerAgent: 'cto', authKind: undefined }, {}));
  assert.equal(explicit.message, err.message);
});

test('a kind that is not one of the known values is refused, and its text is never echoed into the message', () => {
  for (const bogus of ['OAuth', 'OAUTH', 'oauth ', ' oauth', 'oauth\n', 'oauth' + String.fromCharCode(0), 'oauth2', '', 'x'.repeat(200), '<script>alert(1)</script>', 'Bearer abc', 'a b']) {
    const err = refusal(() => assertBridgeAccess({ callerAgent: 'cto', authKind: bogus as AuthKind }, {}));
    assert.equal(err.code, 'aws_mcp_forbidden', JSON.stringify(bogus));
    if (/^[a-z0-9-]{1,16}$/.test(bogus)) continue; // a short lowercase token is a safe label
    assert.match(err.message, /authenticated with a "unrecognized" credential/);
    assert.equal(err.message.includes('script'), false);
    assert.equal(err.message.includes('Bearer'), false);
  }
});

test('the kill switch is on only for true, 1, yes or on (any case, surrounding space ignored)', () => {
  for (const on of ['true', 'TRUE', 'True', ' true ', '1', 'yes', 'YES', 'on', 'On', '\ttrue\n']) {
    assert.equal(bridgeDisabled({ [AWS_MCP_BRIDGE_DISABLED_ENV]: on }), true, JSON.stringify(on));
  }
  for (const off of [undefined, '', ' ', 'false', 'FALSE', '0', 'no', 'off', 'disabled', 'enabled', 'tru', 'truee', '2', 'null', 'undefined']) {
    assert.equal(bridgeDisabled({ [AWS_MCP_BRIDGE_DISABLED_ENV]: off }), false, JSON.stringify(off));
  }
  assert.equal(bridgeDisabled({}), false);
  assert.equal(AWS_MCP_BRIDGE_DISABLED_ENV, 'AWS_MCP_BRIDGE_DISABLED');
});

test('with the kill switch on, an accepted caller is refused as disabled', () => {
  const err = refusal(() => assertBridgeAccess({ callerAgent: 'cto', authKind: 'oauth' }, { [AWS_MCP_BRIDGE_DISABLED_ENV]: 'true' }));
  assert.equal(err.code, 'aws_mcp_disabled');
  assert.equal(
    err.message,
    'aws_mcp_disabled: the AWS bridge is switched off by the operator (AWS_MCP_BRIDGE_DISABLED). No AWS request was made.',
  );
});

test('the order is lane, then authentication kind, then kill switch', () => {
  const on = { [AWS_MCP_BRIDGE_DISABLED_ENV]: 'true' };
  assert.equal(refusal(() => assertBridgeAccess({ callerAgent: 'cfo', authKind: 'oauth' }, on)).code, 'aws_mcp_forbidden');
  assert.match(refusal(() => assertBridgeAccess({ callerAgent: 'cfo', authKind: 'm365' }, on)).message, /CTO lane only/);
  assert.match(refusal(() => assertBridgeAccess({ callerAgent: 'cto', authKind: 'm365' }, on)).message, /"m365" credential/);
  assert.equal(refusal(() => assertBridgeAccess({ callerAgent: 'cto', authKind: 'oauth' }, on)).code, 'aws_mcp_disabled');
});

test('the environment is read on every call, from process.env by default', () => {
  const previous = process.env[AWS_MCP_BRIDGE_DISABLED_ENV];
  try {
    delete process.env[AWS_MCP_BRIDGE_DISABLED_ENV];
    assert.doesNotThrow(() => assertBridgeAccess({ callerAgent: 'cto', authKind: 'oauth' }));
    process.env[AWS_MCP_BRIDGE_DISABLED_ENV] = 'on';
    assert.equal(refusal(() => assertBridgeAccess({ callerAgent: 'cto', authKind: 'oauth' })).code, 'aws_mcp_disabled');
    process.env[AWS_MCP_BRIDGE_DISABLED_ENV] = 'false';
    assert.doesNotThrow(() => assertBridgeAccess({ callerAgent: 'cto', authKind: 'oauth' }));
  } finally {
    if (previous === undefined) delete process.env[AWS_MCP_BRIDGE_DISABLED_ENV];
    else process.env[AWS_MCP_BRIDGE_DISABLED_ENV] = previous;
  }
});

test('refusal errors carry a code, start their message with it, and are plain Errors', () => {
  for (const code of ['aws_mcp_forbidden', 'aws_mcp_disabled', 'aws_mcp_invalid_input', 'aws_mcp_tool_blocked', 'aws_mcp_tool_not_allowed'] as const) {
    const err = new AwsMcpRefusalError(code, 'detail');
    assert.ok(err instanceof Error);
    assert.equal(err.code, code);
    assert.equal(err.message, `${code}: detail`);
    assert.equal(err.name, 'AwsMcpRefusalError');
  }
});
