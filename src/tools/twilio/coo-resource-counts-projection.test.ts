import { test } from 'node:test';
import assert from 'node:assert/strict';
import { projectTwilioResourceCounts, readCooTwilioResourceCounts, twilioPageSizeSchema } from './coo-resource-counts-projection.js';

test('COO projection returns only bounded page counts from synthetic Twilio objects', () => {
  const sentinel = 'SYNTHETIC_DO_NOT_RETURN_7265';
  const projected = projectTwilioResourceCounts({
    requested_page_size: 2,
    messaging_services: [{ sid: sentinel, callback_url: `https://example.invalid/${sentinel}` }],
    incoming_numbers: [{ phone_number: sentinel, friendly_name: sentinel }],
  });

  assert.deepEqual(projected, {
    requested_page_size: 2,
    messaging_services_returned: 1,
    incoming_numbers_returned: 1,
  });
  assert.equal(JSON.stringify(projected).includes(sentinel), false);
});

test('COO projection rejects malformed list results instead of reporting false zeroes', () => {
  assert.throws(() => projectTwilioResourceCounts({
    requested_page_size: 20,
    messaging_services: null as unknown as readonly unknown[],
    incoming_numbers: [],
  }), TypeError);
});

test('page-size contract accepts only integer bounds 1 through 100', () => {
  assert.equal(twilioPageSizeSchema.parse(1), 1);
  assert.equal(twilioPageSizeSchema.parse(100), 100);
  assert.throws(() => twilioPageSizeSchema.parse(0));
  assert.throws(() => twilioPageSizeSchema.parse(101));
});

test('non-COO callers are rejected before either provider list is invoked', async () => {
  let providerCalls = 0;
  await assert.rejects(readCooTwilioResourceCounts({
    caller: 'external', pageSize: 20,
    listMessagingServices: async () => { providerCalls++; return []; },
    listIncomingNumbers: async () => { providerCalls++; return []; },
  }), /COO lane only/);
  assert.equal(providerCalls, 0);
});

test('failed provider details do not appear in count-tool errors', async () => {
  const secret = 'SYNTHETIC_PROVIDER_DETAIL_SENTINEL';
  await assert.rejects(readCooTwilioResourceCounts({
    caller: 'coo', pageSize: 20,
    listMessagingServices: async () => { throw new Error(secret); },
    listIncomingNumbers: async () => [],
  }), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /counts are unavailable/);
    assert.equal(error.message.includes(secret), false);
    return true;
  });
});

test('count tool preserves requested page counts and forwards the same bounded size', async () => {
  const pageSizes: number[] = [];
  const result = await readCooTwilioResourceCounts({
    caller: 'coo', pageSize: 100,
    listMessagingServices: async (size) => { pageSizes.push(size); return [{ sid: 'synthetic' }]; },
    listIncomingNumbers: async (size) => { pageSizes.push(size); return [{ phone_number: 'synthetic' }, {}]; },
  });
  assert.deepEqual(pageSizes, [100, 100]);
  assert.deepEqual(result, { requested_page_size: 100, messaging_services_returned: 1, incoming_numbers_returned: 2 });
});

test('invalid sizes are refused before either provider is called', async () => {
  for (const pageSize of [0, 101, 1.5, NaN]) {
    let calls = 0;
    await assert.rejects(readCooTwilioResourceCounts({
      caller: 'coo', pageSize,
      listMessagingServices: async () => { calls++; return []; },
      listIncomingNumbers: async () => { calls++; return []; },
    }), /integer from 1 through 100/);
    assert.equal(calls, 0);
  }
});

test('an oversized returned page is not misreported as bounded', () => {
  assert.throws(() => projectTwilioResourceCounts({
    requested_page_size: 1, messaging_services: [{}, {}], incoming_numbers: [],
  }), /exceeded the requested page size/);
});
