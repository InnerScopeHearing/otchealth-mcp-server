/**
 * Who may use the AWS MCP bridge: the CTO lane over an interactive OAuth session only (a token from the
 * authorization_code grant or its refresh_token), with an operator kill switch. These are the unit tests
 * for the access check itself; bridge.test.ts proves it runs before any AWS use.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OAUTH_GRANT_TYPES, type AuthKind, type OAuthGrantType } from '../../server/request-context.js';
import {
  AWS_MCP_ACCEPTED_AUTH_GRANTS,
  AWS_MCP_ACCEPTED_AUTH_KIND,
  AWS_MCP_BRIDGE_DISABLED_ENV,
  AwsMcpRefusalError,
  assertBridgeAccess,
  bridgeDisabled,
} from './access.js';

const ALL_KINDS: readonly AuthKind[] = ['oauth', 'descope', 'connector', 'copilot', 'copilot-dev', 'eval', 'm365', 'codex'];
const LANES = ['developer', 'cfo', 'clo', 'clo-personal', 'coo', 'cro', 'cpo', 'cco', 'exec', 'copilot-agent', 'external-read', 'wefunder-campaign-director', '', 'CTO', 'Cto', 'cto ', ' cto'];
const INTERACTIVE_GRANTS: readonly OAuthGrantType[] = ['authorization_code', 'refresh_token'];
const MACHINE_GRANT: OAuthGrantType = 'client_credentials';
/** An accepted caller: the CTO lane, an OAuth session, a token from a human sign-in. */
const ACCEPTED = { callerAgent: 'cto', authKind: 'oauth', authGrant: 'authorization_code' } as const;

function refusal(run: () => void): AwsMcpRefusalError {
  try {
    run();
  } catch (err) {
    assert.ok(err instanceof AwsMcpRefusalError, String(err));
    return err;
  }
  assert.fail('expected a refusal');
}

test('the accepted authentication kind is oauth, and only the cto lane over oauth with an interactive grant passes (switch off)', () => {
  assert.equal(AWS_MCP_ACCEPTED_AUTH_KIND, 'oauth');
  assert.doesNotThrow(() => assertBridgeAccess(ACCEPTED, {}));
  for (const kind of ALL_KINDS) {
    for (const lane of ['cto', ...LANES]) {
      for (const grant of [...OAUTH_GRANT_TYPES, undefined]) {
        const passes = lane === 'cto' && kind === 'oauth' && grant !== undefined && INTERACTIVE_GRANTS.includes(grant);
        if (passes) continue;
        assert.throws(
          () => assertBridgeAccess({ callerAgent: lane, authKind: kind, authGrant: grant }, {}),
          AwsMcpRefusalError,
          `${lane} / ${kind} / ${String(grant)}`,
        );
      }
    }
  }
});

test('a lane other than cto is refused as forbidden whatever the kind or grant, and the message does not mention the credential', () => {
  for (const lane of LANES) {
    for (const kind of [...ALL_KINDS, undefined]) {
      for (const grant of [...OAUTH_GRANT_TYPES, undefined]) {
        const err = refusal(() => assertBridgeAccess({ callerAgent: lane, authKind: kind, authGrant: grant }, {}));
        assert.equal(err.code, 'aws_mcp_forbidden');
        assert.equal(err.message, 'aws_mcp_forbidden: the AWS bridge is available to the CTO lane only.');
      }
    }
  }
});

test('the cto lane over any credential kind but oauth is refused, and the message names the kind and says no AWS request was made', () => {
  for (const kind of ALL_KINDS.filter((k) => k !== 'oauth')) {
    // A static credential has no OAuth grant, but a recorded grant must not rescue a non-oauth kind either.
    for (const grant of [undefined, 'authorization_code' as const]) {
      const err = refusal(() => assertBridgeAccess({ callerAgent: 'cto', authKind: kind, authGrant: grant }, {}));
      assert.equal(err.code, 'aws_mcp_forbidden');
      assert.equal(err.name, 'AwsMcpRefusalError');
      assert.equal(
        err.message,
        `aws_mcp_forbidden: the AWS bridge serves OAuth-authenticated CTO sessions only (the claude.ai connector), and this session authenticated with a "${kind}" credential, which is not an OAuth session. ` +
          'Static tokens and other credential types are refused. No AWS request was made.',
      );
    }
  }
});

test('the cto lane with no recorded authentication kind is refused as not oauth', () => {
  const err = refusal(() => assertBridgeAccess({ callerAgent: 'cto' }, {}));
  assert.equal(err.code, 'aws_mcp_forbidden');
  assert.match(err.message, /this session does not record how it authenticated/);
  assert.match(err.message, /No AWS request was made\.$/);
  const explicit = refusal(() => assertBridgeAccess({ callerAgent: 'cto', authKind: undefined }, {}));
  assert.equal(explicit.message, err.message);
  // Even with an interactive grant recorded, a request that never recorded its kind is refused.
  const withGrant = refusal(() => assertBridgeAccess({ callerAgent: 'cto', authGrant: 'authorization_code' }, {}));
  assert.equal(withGrant.message, err.message);
});

test('a kind that is not one of the known values is refused, and its text is never echoed into the message', () => {
  for (const bogus of ['OAuth', 'OAUTH', 'oauth ', ' oauth', 'oauth\n', 'oauth' + String.fromCharCode(0), 'oauth2', '', 'x'.repeat(200), '<script>alert(1)</script>', 'Bearer abc', 'a b']) {
    const err = refusal(() => assertBridgeAccess({ callerAgent: 'cto', authKind: bogus as AuthKind, authGrant: 'authorization_code' }, {}));
    assert.equal(err.code, 'aws_mcp_forbidden', JSON.stringify(bogus));
    if (/^[a-z0-9-]{1,16}$/.test(bogus)) continue; // a short lowercase token is a safe label
    assert.match(err.message, /authenticated with a "unrecognized" credential/);
    assert.equal(err.message.includes('script'), false);
    assert.equal(err.message.includes('Bearer'), false);
  }
});

test('the accepted OAuth grants are authorization_code and refresh_token, and never client_credentials', () => {
  assert.deepEqual([...AWS_MCP_ACCEPTED_AUTH_GRANTS], ['authorization_code', 'refresh_token']);
  assert.equal(AWS_MCP_ACCEPTED_AUTH_GRANTS.includes(MACHINE_GRANT), false);
  // Every grant the gateway can stamp is either accepted or deliberately refused: none is left undecided.
  assert.deepEqual([...OAUTH_GRANT_TYPES].sort(), ['authorization_code', 'client_credentials', 'refresh_token']);
  for (const grant of INTERACTIVE_GRANTS) {
    assert.doesNotThrow(() => assertBridgeAccess({ callerAgent: 'cto', authKind: 'oauth', authGrant: grant }, {}), grant);
  }
});

test('an OAuth token from the client_credentials grant is refused as a machine credential, with its own code', () => {
  const err = refusal(() => assertBridgeAccess({ callerAgent: 'cto', authKind: 'oauth', authGrant: 'client_credentials' }, {}));
  assert.equal(err.code, 'aws_mcp_grant_refused');
  assert.equal(err.name, 'AwsMcpRefusalError');
  assert.equal(
    err.message,
    'aws_mcp_grant_refused: the AWS bridge serves interactive OAuth sessions only (a sign-in through the claude.ai connector, or the refresh of one), ' +
      'and this token was issued by the client_credentials grant, which is a machine credential and not an interactive sign-in. No AWS request was made.',
  );
  assert.notEqual(err.code, 'aws_mcp_forbidden', 'a machine token is told apart from a static credential');
});

test('an OAuth token that records no grant is refused, with advice to reconnect', () => {
  for (const request of [{ callerAgent: 'cto', authKind: 'oauth' as const }, { callerAgent: 'cto', authKind: 'oauth' as const, authGrant: undefined }]) {
    const err = refusal(() => assertBridgeAccess(request, {}));
    assert.equal(err.code, 'aws_mcp_grant_refused');
    assert.equal(
      err.message,
      'aws_mcp_grant_refused: the AWS bridge serves interactive OAuth sessions only (a sign-in through the claude.ai connector, or the refresh of one), ' +
        'and this token does not record how it was issued, so it cannot be shown to come from an interactive sign-in ' +
        '(a token minted before grant tracking has none, so reconnect the connector to get a fresh one). No AWS request was made.',
    );
  }
});

test('a grant that is not one of the known values is refused, and its text is never echoed into the message', () => {
  for (const bogus of ['password', 'implicit', 'AUTHORIZATION_CODE', 'authorization_code ', ' authorization_code', 'authorization_code\n', '', 'x'.repeat(200), '<script>alert(1)</script>', 'Bearer abc', 'a b', 'refresh-token']) {
    const err = refusal(() => assertBridgeAccess({ callerAgent: 'cto', authKind: 'oauth', authGrant: bogus as OAuthGrantType }, {}));
    assert.equal(err.code, 'aws_mcp_grant_refused', JSON.stringify(bogus));
    assert.match(err.message, /No AWS request was made\.$/);
    assert.equal(err.message.includes('script'), false);
    assert.equal(err.message.includes('Bearer'), false);
    if (/^[a-z_]{1,32}$/.test(bogus)) {
      assert.match(err.message, new RegExp(`records a "${bogus}" grant, which is not an interactive sign-in`));
    } else {
      assert.match(err.message, /records a "unrecognized" grant, which is not an interactive sign-in/);
    }
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
  const err = refusal(() => assertBridgeAccess(ACCEPTED, { [AWS_MCP_BRIDGE_DISABLED_ENV]: 'true' }));
  assert.equal(err.code, 'aws_mcp_disabled');
  assert.equal(
    err.message,
    'aws_mcp_disabled: the AWS bridge is switched off by the operator (AWS_MCP_BRIDGE_DISABLED). No AWS request was made.',
  );
});

test('the order is lane, then authentication kind, then OAuth grant, then kill switch', () => {
  const on = { [AWS_MCP_BRIDGE_DISABLED_ENV]: 'true' };
  assert.equal(refusal(() => assertBridgeAccess({ callerAgent: 'cfo', authKind: 'oauth', authGrant: 'client_credentials' }, on)).code, 'aws_mcp_forbidden');
  assert.match(refusal(() => assertBridgeAccess({ callerAgent: 'cfo', authKind: 'm365' }, on)).message, /CTO lane only/);
  assert.match(refusal(() => assertBridgeAccess({ callerAgent: 'cto', authKind: 'm365', authGrant: 'client_credentials' }, on)).message, /"m365" credential/);
  assert.equal(refusal(() => assertBridgeAccess({ callerAgent: 'cto', authKind: 'oauth', authGrant: 'client_credentials' }, on)).code, 'aws_mcp_grant_refused');
  assert.equal(refusal(() => assertBridgeAccess({ callerAgent: 'cto', authKind: 'oauth' }, on)).code, 'aws_mcp_grant_refused');
  assert.equal(refusal(() => assertBridgeAccess(ACCEPTED, on)).code, 'aws_mcp_disabled');
  assert.equal(refusal(() => assertBridgeAccess({ callerAgent: 'cto', authKind: 'oauth', authGrant: 'refresh_token' }, on)).code, 'aws_mcp_disabled');
});

test('the environment is read on every call, from process.env by default', () => {
  const previous = process.env[AWS_MCP_BRIDGE_DISABLED_ENV];
  try {
    delete process.env[AWS_MCP_BRIDGE_DISABLED_ENV];
    assert.doesNotThrow(() => assertBridgeAccess(ACCEPTED));
    process.env[AWS_MCP_BRIDGE_DISABLED_ENV] = 'on';
    assert.equal(refusal(() => assertBridgeAccess(ACCEPTED)).code, 'aws_mcp_disabled');
    process.env[AWS_MCP_BRIDGE_DISABLED_ENV] = 'false';
    assert.doesNotThrow(() => assertBridgeAccess(ACCEPTED));
  } finally {
    if (previous === undefined) delete process.env[AWS_MCP_BRIDGE_DISABLED_ENV];
    else process.env[AWS_MCP_BRIDGE_DISABLED_ENV] = previous;
  }
});

test('refusal errors carry a code, start their message with it, and are plain Errors', () => {
  for (const code of ['aws_mcp_forbidden', 'aws_mcp_grant_refused', 'aws_mcp_disabled', 'aws_mcp_invalid_input', 'aws_mcp_tool_blocked', 'aws_mcp_tool_not_allowed'] as const) {
    const err = new AwsMcpRefusalError(code, 'detail');
    assert.ok(err instanceof Error);
    assert.equal(err.code, code);
    assert.equal(err.message, `${code}: detail`);
    assert.equal(err.name, 'AwsMcpRefusalError');
  }
});
