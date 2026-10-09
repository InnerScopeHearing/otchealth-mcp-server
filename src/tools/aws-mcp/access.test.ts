/**
 * Who may use the AWS MCP bridge: the CTO lane over an OAuth-issued session only (a token from the
 * authorization_code grant or its refresh_token), with a fail-closed operator kill switch. These are the
 * unit tests for the access check itself; bridge.test.ts proves it runs before any AWS use. The grant
 * shows how the token was issued, not that a person is present, and nothing here claims otherwise.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OAUTH_GRANT_TYPES, type AuthKind, type OAuthGrantType } from '../../server/request-context.js';
import {
  AWS_MCP_ACCEPTED_AUTH_GRANTS,
  AWS_MCP_ACCEPTED_AUTH_KIND,
  AWS_MCP_BRIDGE_DISABLED_ENV,
  AWS_MCP_BRIDGE_ENABLED_VALUES,
  AwsMcpRefusalError,
  assertBridgeAccess,
  bridgeDisabled,
} from './access.js';

const ALL_KINDS: readonly AuthKind[] = ['oauth', 'descope', 'connector', 'copilot', 'copilot-dev', 'eval', 'm365', 'codex'];
const LANES = ['developer', 'cfo', 'clo', 'clo-personal', 'coo', 'cro', 'cpo', 'cco', 'exec', 'copilot-agent', 'external-read', 'wefunder-campaign-director', '', 'CTO', 'Cto', 'cto ', ' cto'];
const ACCEPTED_GRANTS: readonly OAuthGrantType[] = ['authorization_code', 'refresh_token'];
const MACHINE_GRANT: OAuthGrantType = 'client_credentials';
/** An accepted caller: the CTO lane, an OAuth session, a token from the authorization_code grant. */
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

test('the accepted authentication kind is oauth, and only the cto lane over oauth with an accepted grant passes (switch off)', () => {
  assert.equal(AWS_MCP_ACCEPTED_AUTH_KIND, 'oauth');
  assert.doesNotThrow(() => assertBridgeAccess(ACCEPTED, {}));
  for (const kind of ALL_KINDS) {
    for (const lane of ['cto', ...LANES]) {
      for (const grant of [...OAUTH_GRANT_TYPES, undefined]) {
        const passes = lane === 'cto' && kind === 'oauth' && grant !== undefined && ACCEPTED_GRANTS.includes(grant);
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
  // Even with an accepted grant recorded, a request that never recorded its kind is refused.
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
  for (const grant of ACCEPTED_GRANTS) {
    assert.doesNotThrow(() => assertBridgeAccess({ callerAgent: 'cto', authKind: 'oauth', authGrant: grant }, {}), grant);
  }
});

test('an OAuth token from the client_credentials grant is refused as a machine credential, with its own code', () => {
  const err = refusal(() => assertBridgeAccess({ callerAgent: 'cto', authKind: 'oauth', authGrant: 'client_credentials' }, {}));
  assert.equal(err.code, 'aws_mcp_grant_refused');
  assert.equal(err.name, 'AwsMcpRefusalError');
  assert.equal(
    err.message,
    'aws_mcp_grant_refused: the AWS bridge serves OAuth-issued sessions only (a token from the authorization_code grant, or from the refresh_token grant that renews it), ' +
      'and this token was issued by the client_credentials grant, which is a machine credential. No AWS request was made.',
  );
  assert.notEqual(err.code, 'aws_mcp_forbidden', 'a machine token is told apart from a static credential');
});

test('an OAuth token that records no grant is refused, with advice to reconnect', () => {
  for (const request of [{ callerAgent: 'cto', authKind: 'oauth' as const }, { callerAgent: 'cto', authKind: 'oauth' as const, authGrant: undefined }]) {
    const err = refusal(() => assertBridgeAccess(request, {}));
    assert.equal(err.code, 'aws_mcp_grant_refused');
    assert.equal(
      err.message,
      'aws_mcp_grant_refused: the AWS bridge serves OAuth-issued sessions only (a token from the authorization_code grant, or from the refresh_token grant that renews it), ' +
        'and this token does not record how it was issued, so it cannot be shown to come from the authorization_code or refresh_token grant ' +
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
      assert.match(err.message, new RegExp(`records a "${bogus}" grant, which the bridge does not accept`));
    } else {
      assert.match(err.message, /records a "unrecognized" grant, which the bridge does not accept/);
    }
  }
});

test('the kill switch fails closed: the bridge stays enabled only for blank, false, 0, no or off (any case, surrounding space ignored)', () => {
  for (const enabled of [undefined, '', ' ', '   ', '\t\n', 'false', 'FALSE', 'False', ' false ', '0', 'no', 'No', 'NO', 'off', 'Off', 'OFF', ' off ', '\toff\n']) {
    assert.equal(bridgeDisabled({ [AWS_MCP_BRIDGE_DISABLED_ENV]: enabled }), false, `enabled: ${JSON.stringify(enabled)}`);
  }
  assert.equal(bridgeDisabled({}), false, 'an unset switch leaves the bridge enabled');
  assert.deepEqual([...AWS_MCP_BRIDGE_ENABLED_VALUES], ['', 'false', '0', 'no', 'off']);
  assert.equal(AWS_MCP_BRIDGE_DISABLED_ENV, 'AWS_MCP_BRIDGE_DISABLED');
});

test('the kill switch disables the bridge for every other value, including the true-like ones and every typo', () => {
  const disabling = [
    'true', 'TRUE', 'True', ' true ', '1', 'yes', 'YES', 'on', 'On', '\ttrue\n',
    // typos and near misses that the earlier fail-open rule left enabled
    'y', 'Y', 't', 'enabled', 'disabled', 'enable', 'disable', 'ture', 'tru', 'truee', 'flase', 'fasle', 'of', 'offf', 'nope', 'n',
    // other values
    '2', '-1', '00', '0.0', 'null', 'undefined', 'none', 'nil', 'garbage', 'off!', 'false;', 'no no', 'false false', 'of f',
    'x'.repeat(200), '<script>alert(1)</script>', 'Bearer abc',
  ];
  for (const value of disabling) {
    assert.equal(bridgeDisabled({ [AWS_MCP_BRIDGE_DISABLED_ENV]: value }), true, JSON.stringify(value));
    const err = refusal(() => assertBridgeAccess(ACCEPTED, { [AWS_MCP_BRIDGE_DISABLED_ENV]: value }));
    assert.equal(err.code, 'aws_mcp_disabled', JSON.stringify(value));
    assert.equal(err.message.includes('script'), false, 'the value is never echoed into the message');
  }
});

test('every enabling value is lowercase and trimmed, so no mixed-case or padded spelling can slip past the list', () => {
  for (const value of AWS_MCP_BRIDGE_ENABLED_VALUES) {
    assert.equal(value, value.trim().toLowerCase(), JSON.stringify(value));
  }
  assert.equal(new Set(AWS_MCP_BRIDGE_ENABLED_VALUES).size, AWS_MCP_BRIDGE_ENABLED_VALUES.length);
});

test('with the kill switch on, an accepted caller is refused as disabled', () => {
  const err = refusal(() => assertBridgeAccess(ACCEPTED, { [AWS_MCP_BRIDGE_DISABLED_ENV]: 'true' }));
  assert.equal(err.code, 'aws_mcp_disabled');
  assert.equal(
    err.message,
    'aws_mcp_disabled: the AWS bridge is switched off (AWS_MCP_BRIDGE_DISABLED is set to something other than blank, false, 0, no or off). No AWS request was made.',
  );
  // A typo disables it with the same message, so it is never silently left on.
  const typo = refusal(() => assertBridgeAccess(ACCEPTED, { [AWS_MCP_BRIDGE_DISABLED_ENV]: 'enabled' }));
  assert.equal(typo.message, err.message);
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
    process.env[AWS_MCP_BRIDGE_DISABLED_ENV] = 'ture'; // a typo disables the bridge
    assert.equal(refusal(() => assertBridgeAccess(ACCEPTED)).code, 'aws_mcp_disabled');
    process.env[AWS_MCP_BRIDGE_DISABLED_ENV] = 'false';
    assert.doesNotThrow(() => assertBridgeAccess(ACCEPTED));
    process.env[AWS_MCP_BRIDGE_DISABLED_ENV] = '';
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
