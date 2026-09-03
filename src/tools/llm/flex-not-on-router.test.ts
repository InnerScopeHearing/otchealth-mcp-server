import test from 'node:test';
import assert from 'node:assert/strict';
import { backgroundChatOpts } from './azure.js';

// Pins the LIVE-OBSERVED failure, not a style preference: on gateway rev 41 the router tier with
// flex applied timed out 2 of 2 in the background lane while every other combination returned
// immediately. If a future edit re-enables flex for router, these fail.
test('router tier never requests flex, even in the background lane', () => {
  const prev = process.env.OPENAI_FLEX_BACKGROUND;
  delete process.env.OPENAI_FLEX_BACKGROUND; // flex ON by default
  try {
    const router = backgroundChatOpts('background', 'cto', 'classify', 'router');
    assert.equal(router.serviceTier, undefined, 'router must not carry service_tier flex');
    assert.ok(router.promptCacheKey, 'router still gets the prompt cache key (unaffected by this fix)');

    for (const tier of ['standard', 'high']) {
      const o = backgroundChatOpts('background', 'cto', 'classify', tier);
      assert.equal(o.serviceTier, 'flex', `${tier} keeps the 50% flex discount`);
    }

    // The blanket kill switch still works, and still covers every tier.
    process.env.OPENAI_FLEX_BACKGROUND = '0';
    assert.equal(backgroundChatOpts('background', 'cto', 'classify', 'standard').serviceTier, undefined);
    assert.equal(backgroundChatOpts('background', 'cto', 'classify', 'router').serviceTier, undefined);
  } finally {
    if (prev === undefined) delete process.env.OPENAI_FLEX_BACKGROUND;
    else process.env.OPENAI_FLEX_BACKGROUND = prev;
  }
});

test('non-background lanes are untouched on every tier', () => {
  for (const lc of ['hot', 'normal'] as const) {
    for (const tier of ['standard', 'high', 'router']) {
      assert.deepEqual(backgroundChatOpts(lc, 'cto', 'classify', tier), {}, `${lc}/${tier} must stay empty`);
    }
  }
});
