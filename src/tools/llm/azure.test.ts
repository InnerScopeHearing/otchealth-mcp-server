import { test } from 'node:test';
import assert from 'node:assert/strict';

// Own file/process is not required here (flexBackgroundEnabled/backgroundChatOpts read
// process.env FRESH on every call rather than through loadEnv()'s per-process cache), but the
// module still transitively imports config/env.ts, so the usual required-var stubs are needed
// for the FIRST loadEnv() call anything in this process might trigger.
process.env.CIO_SITE_ID ||= 'test';
process.env.CIO_TRACK_KEY ||= 'test';
process.env.CIO_APP_API_BEARER ||= 'test';
process.env.PERPLEXITY_CONNECTOR_TOKEN ||= 'x'.repeat(32);
process.env.ADMIN_REVOKE_TOKEN ||= 'x'.repeat(32);

const { flexBackgroundEnabled, backgroundChatOpts } = await import('./azure.js');

// ---- flexBackgroundEnabled() -- the OPENAI_FLEX_BACKGROUND kill-switch, read fresh per call ----

test('flexBackgroundEnabled: defaults to true when OPENAI_FLEX_BACKGROUND is unset', () => {
  delete process.env.OPENAI_FLEX_BACKGROUND;
  assert.equal(flexBackgroundEnabled(), true);
});

test('flexBackgroundEnabled: true for blank/whitespace-only values (fail-open toward the default)', () => {
  process.env.OPENAI_FLEX_BACKGROUND = '';
  assert.equal(flexBackgroundEnabled(), true);
  process.env.OPENAI_FLEX_BACKGROUND = '   ';
  assert.equal(flexBackgroundEnabled(), true);
  delete process.env.OPENAI_FLEX_BACKGROUND;
});

test('flexBackgroundEnabled: the literal string "0" disables it (the kill-switch)', () => {
  process.env.OPENAI_FLEX_BACKGROUND = '0';
  assert.equal(flexBackgroundEnabled(), false);
  delete process.env.OPENAI_FLEX_BACKGROUND;
});

test('flexBackgroundEnabled: any other non-"0" value (a typo, "false", "off") stays enabled -- "0" is the ONLY disabling sentinel', () => {
  for (const v of ['false', 'off', 'no', '1', 'zero']) {
    process.env.OPENAI_FLEX_BACKGROUND = v;
    assert.equal(flexBackgroundEnabled(), true, `expected enabled for OPENAI_FLEX_BACKGROUND=${v}`);
  }
  delete process.env.OPENAI_FLEX_BACKGROUND;
});

test('flexBackgroundEnabled: is read FRESH on every call, not cached (can flip within one test file/process)', () => {
  delete process.env.OPENAI_FLEX_BACKGROUND;
  assert.equal(flexBackgroundEnabled(), true);
  process.env.OPENAI_FLEX_BACKGROUND = '0';
  assert.equal(flexBackgroundEnabled(), false);
  delete process.env.OPENAI_FLEX_BACKGROUND;
  assert.equal(flexBackgroundEnabled(), true);
});

// ---- backgroundChatOpts() -- the pure wiring: latencyClass -> chat() opts additions ----

test('backgroundChatOpts: latencyClass "background" yields serviceTier:"flex" + a promptCacheKey, by default', () => {
  delete process.env.OPENAI_FLEX_BACKGROUND;
  const opts = backgroundChatOpts('background', 'cto', 'summarize', 'standard');
  assert.deepEqual(opts, { promptCacheKey: 'llm:cto:summarize:standard', serviceTier: 'flex' });
});

test('backgroundChatOpts: promptCacheKey matches semantic-cache.ts scopeFor() EXACTLY (the same partition key), not the raw input content', async () => {
  const { scopeFor } = await import('./semantic-cache.js');
  const opts = backgroundChatOpts('background', 'cfo', 'classify', 'high');
  assert.equal(opts.promptCacheKey, scopeFor('cfo', 'classify', 'high'));
});

test('backgroundChatOpts: two calls with the SAME task/tier/caller but DIFFERENT free-text task content share the identical promptCacheKey (that is the whole point -- a stable prefix, not per-input)', () => {
  const a = backgroundChatOpts('background', 'cto', 'extract', 'standard');
  const b = backgroundChatOpts('background', 'cto', 'extract', 'standard');
  assert.equal(a.promptCacheKey, b.promptCacheKey);
});

test('backgroundChatOpts: the kill-switch OPENAI_FLEX_BACKGROUND=0 disables ONLY serviceTier, promptCacheKey is untouched', () => {
  process.env.OPENAI_FLEX_BACKGROUND = '0';
  const opts = backgroundChatOpts('background', 'cto', 'summarize', 'standard');
  assert.equal(opts.serviceTier, undefined, 'serviceTier must be absent, not just falsy-but-present');
  assert.equal('serviceTier' in opts, false);
  assert.equal(opts.promptCacheKey, 'llm:cto:summarize:standard', 'promptCacheKey is a pure routing hint, independent of the flex kill-switch');
  delete process.env.OPENAI_FLEX_BACKGROUND;
});

test('backgroundChatOpts: latencyClass "normal" returns {} -- no serviceTier, no promptCacheKey', () => {
  delete process.env.OPENAI_FLEX_BACKGROUND;
  assert.deepEqual(backgroundChatOpts('normal', 'cto', 'summarize', 'standard'), {});
});

test('backgroundChatOpts: latencyClass "hot" returns {} -- a user-blocking call never gets flex or a cache-routing hint from this path', () => {
  assert.deepEqual(backgroundChatOpts('hot', 'cto', 'summarize', 'standard'), {});
});

test('backgroundChatOpts: "normal"/"hot" return {} regardless of the kill-switch state (the switch only matters once latencyClass is "background")', () => {
  process.env.OPENAI_FLEX_BACKGROUND = '0';
  assert.deepEqual(backgroundChatOpts('normal', 'cto', 'summarize', 'standard'), {});
  assert.deepEqual(backgroundChatOpts('hot', 'cto', 'summarize', 'standard'), {});
  delete process.env.OPENAI_FLEX_BACKGROUND;
});

test('backgroundChatOpts: different tiers/tasks/callers produce different cache-partition keys (never collide across lanes)', () => {
  const a = backgroundChatOpts('background', 'cto', 'summarize', 'standard');
  const b = backgroundChatOpts('background', 'cfo', 'summarize', 'standard');
  const c = backgroundChatOpts('background', 'cto', 'classify', 'standard');
  const d = backgroundChatOpts('background', 'cto', 'summarize', 'high');
  const keys = new Set([a.promptCacheKey, b.promptCacheKey, c.promptCacheKey, d.promptCacheKey]);
  assert.equal(keys.size, 4, 'every distinct (caller, task, tier) combination must get its own key');
});
