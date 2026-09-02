import { test } from 'node:test';
import assert from 'node:assert/strict';
import { incomingPhoneNumberParams, messagingServiceParams } from './params.js';

test('incomingPhoneNumberParams maps every fallback/method field and sends ONLY what is present', () => {
  assert.deepEqual(incomingPhoneNumberParams({}), {});
  assert.deepEqual(
    incomingPhoneNumberParams({ voice_fallback_url: 'https://h/voice-fb', voice_fallback_method: 'POST', sms_fallback_url: 'https://h/sms-fb', sms_fallback_method: 'POST' }),
    { VoiceFallbackUrl: 'https://h/voice-fb', VoiceFallbackMethod: 'POST', SmsFallbackUrl: 'https://h/sms-fb', SmsFallbackMethod: 'POST' },
  );
  // a fallback-only update must never carry a primary routing key (that is the whole point: the
  // ElevenLabs voice primary and the interim SmsUrl are preserved untouched)
  const p = incomingPhoneNumberParams({ voice_fallback_url: 'https://h/x' });
  assert.equal('VoiceUrl' in p, false); assert.equal('SmsUrl' in p, false); assert.equal('StatusCallback' in p, false);
  assert.deepEqual(
    incomingPhoneNumberParams({ friendly_name: 'n', sms_url: 'https://h/s', sms_method: 'GET', voice_url: 'https://h/v', voice_method: 'POST', status_callback: 'https://h/sc', status_callback_method: 'POST' }),
    { FriendlyName: 'n', SmsUrl: 'https://h/s', SmsMethod: 'GET', VoiceUrl: 'https://h/v', VoiceMethod: 'POST', StatusCallback: 'https://h/sc', StatusCallbackMethod: 'POST' },
  );
});

test('messagingServiceParams maps the v1 Services fields and serializes the boolean explicitly', () => {
  assert.deepEqual(messagingServiceParams({}), {});
  assert.deepEqual(
    messagingServiceParams({ status_callback: 'https://h/status', fallback_url: 'https://h/fb', fallback_method: 'POST', use_inbound_webhook_on_number: true }),
    { StatusCallback: 'https://h/status', FallbackUrl: 'https://h/fb', FallbackMethod: 'POST', UseInboundWebhookOnNumber: 'true' },
  );
  assert.deepEqual(messagingServiceParams({ use_inbound_webhook_on_number: false }), { UseInboundWebhookOnNumber: 'false' });
  assert.deepEqual(messagingServiceParams({ inbound_request_url: 'https://h/in', inbound_method: 'POST', friendly_name: 'svc' }), { InboundRequestUrl: 'https://h/in', InboundMethod: 'POST', FriendlyName: 'svc' });
});
