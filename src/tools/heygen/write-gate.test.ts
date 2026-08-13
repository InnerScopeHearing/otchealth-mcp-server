import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HEYGEN_CREDIT_WRITE_FLAGS,
  HEYGEN_PROVIDER_WRITE_FLAG,
  isHeyGenProviderWriteEnabled,
} from './write-gate.js';

function withFlags(provider: string | undefined, lane: string | undefined, run: () => void): void {
  const previousProvider = process.env[HEYGEN_PROVIDER_WRITE_FLAG];
  const previousLane = process.env.ENABLE_HEYGEN_AVATAR_VIDEO_WRITES;
  try {
    if (provider === undefined) delete process.env[HEYGEN_PROVIDER_WRITE_FLAG];
    else process.env[HEYGEN_PROVIDER_WRITE_FLAG] = provider;
    if (lane === undefined) delete process.env.ENABLE_HEYGEN_AVATAR_VIDEO_WRITES;
    else process.env.ENABLE_HEYGEN_AVATAR_VIDEO_WRITES = lane;
    run();
  } finally {
    if (previousProvider === undefined) delete process.env[HEYGEN_PROVIDER_WRITE_FLAG];
    else process.env[HEYGEN_PROVIDER_WRITE_FLAG] = previousProvider;
    if (previousLane === undefined) delete process.env.ENABLE_HEYGEN_AVATAR_VIDEO_WRITES;
    else process.env.ENABLE_HEYGEN_AVATAR_VIDEO_WRITES = previousLane;
  }
}

test('provider hard stop dominates an accidentally enabled mutation-family flag', () => {
  withFlags('false', 'true', () => {
    assert.equal(isHeyGenProviderWriteEnabled('ENABLE_HEYGEN_AVATAR_VIDEO_WRITES'), false);
  });
});

test('provider mutation is reachable only when both interlock keys are exactly true', () => {
  withFlags('true', 'true', () => {
    assert.equal(isHeyGenProviderWriteEnabled('ENABLE_HEYGEN_AVATAR_VIDEO_WRITES'), true);
  });
  withFlags('true', 'false', () => {
    assert.equal(isHeyGenProviderWriteEnabled('ENABLE_HEYGEN_AVATAR_VIDEO_WRITES'), false);
  });
  withFlags(undefined, 'true', () => {
    assert.equal(isHeyGenProviderWriteEnabled('ENABLE_HEYGEN_AVATAR_VIDEO_WRITES'), false);
  });
});

test('the hard stop covers every credit-consuming HeyGen mutation family', () => {
  assert.deepEqual(HEYGEN_CREDIT_WRITE_FLAGS, [
    'ENABLE_HEYGEN_PROMPT_AVATAR_WRITES',
    'ENABLE_HEYGEN_AVATAR_VIDEO_WRITES',
    'ENABLE_HEYGEN_REFERENCE_LOOK_WRITES',
    'ENABLE_HEYGEN_VIDEO_AGENT_CHAT_WRITES',
    'ENABLE_HEYGEN_VIDEO_AGENT_GENERATION',
    'ENABLE_HEYGEN_ASSET_WRITES',
    'ENABLE_HEYGEN_TRANSLATION_WRITES',
    'ENABLE_HEYGEN_TTS_WRITES',
  ]);
});
