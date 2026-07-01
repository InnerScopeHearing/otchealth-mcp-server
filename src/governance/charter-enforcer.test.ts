import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluate,
  checkGovernance,
  currentGovernanceMode,
  CHARTERS,
  DEFAULT_CHARTER,
} from './charter-enforcer.js';

// ---- evaluate(): pure decision logic, no env, no IO ----

test('evaluate: allows a call in-charter (cto may run a write_orchestrated tool)', () => {
  const result = evaluate('cto', 'depot_trigger_build', 'write_orchestrated');
  assert.equal(result.decision, 'allow');
  assert.match(result.reason, /permits category "write_orchestrated"/);
});

test('evaluate: denies a call out-of-charter (cfo may not run write_orchestrated)', () => {
  const result = evaluate('cfo', 'depot_trigger_build', 'write_orchestrated');
  assert.equal(result.decision, 'deny');
  assert.match(result.reason, /does not permit category "write_orchestrated"/);
  assert.match(result.reason, /cfo/);
});

test('evaluate: allows read + write_simple for a propose-authority lane (clo)', () => {
  assert.equal(evaluate('clo', 'github_get_file_contents', 'read').decision, 'allow');
  assert.equal(evaluate('clo', 'memory_write', 'write_simple').decision, 'allow');
});

test('evaluate: an explicit deniedTools entry denies even if the category is allowed', () => {
  const charters = { ...CHARTERS };
  // Seed a temporary charter with a per-tool deny to exercise the deniedTools branch, then
  // restore CHARTERS untouched (module-level mutation would leak across tests otherwise).
  (CHARTERS as Record<string, unknown>).temp_lane = {
    allowedCategories: ['read', 'write_simple'],
    deniedTools: ['memory_write'],
    authority: 'propose',
  };
  try {
    const result = evaluate('temp_lane', 'memory_write', 'write_simple');
    assert.equal(result.decision, 'deny');
    assert.match(result.reason, /explicitly denies "memory_write"/);
  } finally {
    delete (CHARTERS as Record<string, unknown>).temp_lane;
  }
});

test('evaluate: unknown agent lane falls back to DEFAULT_CHARTER (read + write_simple, propose)', () => {
  const allowRead = evaluate('some-unregistered-lane', 'stripe_get_balance', 'read');
  assert.equal(allowRead.decision, 'allow');
  const denyOrchestrated = evaluate('some-unregistered-lane', 'stripe_create_refund', 'write_orchestrated');
  assert.equal(denyOrchestrated.decision, 'deny');
  assert.deepEqual(DEFAULT_CHARTER.allowedCategories, ['read', 'write_simple']);
});

test('evaluate: empty agent lane (no identity on token) is handled without throwing', () => {
  const result = evaluate('', 'depot_trigger_build', 'write_orchestrated');
  assert.equal(result.decision, 'deny');
  assert.match(result.reason, /\(no agent identity\)/);
});

// ---- currentGovernanceMode(): reads process.env fresh every call ----

test('currentGovernanceMode: defaults to off when unset', () => {
  const prior = process.env.GOVERNANCE_MODE;
  delete process.env.GOVERNANCE_MODE;
  try {
    assert.equal(currentGovernanceMode(), 'off');
  } finally {
    if (prior === undefined) delete process.env.GOVERNANCE_MODE;
    else process.env.GOVERNANCE_MODE = prior;
  }
});

test('currentGovernanceMode: defaults to off for an unrecognized value', () => {
  const prior = process.env.GOVERNANCE_MODE;
  process.env.GOVERNANCE_MODE = 'bogus';
  try {
    assert.equal(currentGovernanceMode(), 'off');
  } finally {
    if (prior === undefined) delete process.env.GOVERNANCE_MODE;
    else process.env.GOVERNANCE_MODE = prior;
  }
});

test('currentGovernanceMode: reflects a live process.env change with no caching', () => {
  const prior = process.env.GOVERNANCE_MODE;
  try {
    process.env.GOVERNANCE_MODE = 'report';
    assert.equal(currentGovernanceMode(), 'report');
    process.env.GOVERNANCE_MODE = 'enforce';
    assert.equal(currentGovernanceMode(), 'enforce');
    process.env.GOVERNANCE_MODE = 'off';
    assert.equal(currentGovernanceMode(), 'off');
  } finally {
    if (prior === undefined) delete process.env.GOVERNANCE_MODE;
    else process.env.GOVERNANCE_MODE = prior;
  }
});

// ---- checkGovernance(): the mode branching registry.ts actually calls ----

function withGovernanceMode<T>(mode: string | undefined, fn: () => T): T {
  const prior = process.env.GOVERNANCE_MODE;
  if (mode === undefined) delete process.env.GOVERNANCE_MODE;
  else process.env.GOVERNANCE_MODE = mode;
  try {
    return fn();
  } finally {
    if (prior === undefined) delete process.env.GOVERNANCE_MODE;
    else process.env.GOVERNANCE_MODE = prior;
  }
}

function withCapturedWarn<T>(fn: () => T): { result: T; warnings: string[] } {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map((a) => String(a)).join(' '));
  };
  try {
    const result = fn();
    return { result, warnings };
  } finally {
    console.warn = original;
  }
}

test('checkGovernance: mode off/unset is a pure no-op, proceeds, logs nothing, even for a denied combo', () => {
  withGovernanceMode(undefined, () => {
    const { result, warnings } = withCapturedWarn(() =>
      checkGovernance('cfo', 'depot_trigger_build', 'write_orchestrated'),
    );
    assert.equal(result.proceed, true);
    assert.equal(result.denial, undefined);
    assert.equal(warnings.length, 0);
  });
});

test('checkGovernance: mode report logs a would-deny JSON line but STILL lets the tool run', () => {
  withGovernanceMode('report', () => {
    const { result, warnings } = withCapturedWarn(() =>
      checkGovernance('cfo', 'depot_trigger_build', 'write_orchestrated'),
    );
    assert.equal(result.proceed, true, 'report mode must never block');
    assert.equal(result.denial, undefined);
    assert.equal(warnings.length, 1);
    const parsed = JSON.parse(warnings[0]);
    assert.equal(parsed.governance, 'would-deny');
    assert.equal(parsed.agent, 'cfo');
    assert.equal(parsed.tool, 'depot_trigger_build');
    assert.equal(parsed.category, 'write_orchestrated');
    assert.ok(typeof parsed.reason === 'string' && parsed.reason.length > 0);
  });
});

test('checkGovernance: mode report logs nothing for an in-charter call', () => {
  withGovernanceMode('report', () => {
    const { result, warnings } = withCapturedWarn(() =>
      checkGovernance('cto', 'depot_trigger_build', 'write_orchestrated'),
    );
    assert.equal(result.proceed, true);
    assert.equal(warnings.length, 0);
  });
});

test('checkGovernance: mode report does not block an unknown lane even on a denied combo', () => {
  withGovernanceMode('report', () => {
    const { result, warnings } = withCapturedWarn(() =>
      checkGovernance('some-unregistered-lane', 'depot_trigger_build', 'write_orchestrated'),
    );
    assert.equal(result.proceed, true, 'report mode never blocks, regardless of lane');
    assert.equal(warnings.length, 1);
    const parsed = JSON.parse(warnings[0]);
    assert.equal(parsed.governance, 'would-deny');
    assert.equal(parsed.agent, 'some-unregistered-lane');
  });
});

test('checkGovernance: mode enforce blocks a denied tool and returns the denial payload; handler is never called', () => {
  withGovernanceMode('enforce', () => {
    let handlerCalled = false;
    const result = checkGovernance('cfo', 'depot_trigger_build', 'write_orchestrated');
    if (result.proceed) {
      handlerCalled = true; // Simulates registry.ts's "only run the handler if proceed".
    }
    assert.equal(result.proceed, false);
    assert.equal(handlerCalled, false);
    assert.ok(result.denial);
    assert.equal(result.denial?.agentLane, 'cfo');
    assert.equal(result.denial?.tool, 'depot_trigger_build');
    assert.equal(result.denial?.category, 'write_orchestrated');
    assert.ok(result.denial?.reason.length ?? 0 > 0);
  });
});

test('checkGovernance: mode enforce still allows an in-charter call through', () => {
  withGovernanceMode('enforce', () => {
    const result = checkGovernance('cto', 'depot_trigger_build', 'write_orchestrated');
    assert.equal(result.proceed, true);
    assert.equal(result.denial, undefined);
  });
});
