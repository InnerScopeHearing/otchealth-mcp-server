import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requireTwilioCollection } from './twilio-list-contract.js';

test('Twilio collection contract accepts a real empty collection', () => {
  assert.deepEqual(requireTwilioCollection({ services: [] }, 'services'), []);
});

test('Twilio collection contract rejects missing, non-array, and non-object results without echoing source', () => {
  for (const [payload, key] of [
    [{}, 'services'], [{ services: null }, 'services'], [{ services: 'customer detail sentinel' }, 'services'],
    [{}, 'incoming_phone_numbers'], [{ incoming_phone_numbers: null }, 'incoming_phone_numbers'],
    [null, 'services'], [[], 'services'],
  ] as const) {
    assert.throws(() => requireTwilioCollection(payload, key), (error: unknown) => {
      assert.ok(error instanceof TypeError);
      assert.equal(error.message, 'Twilio returned a malformed list response.');
      assert.equal(error.message.includes('customer detail sentinel'), false);
      return true;
    });
  }
});
