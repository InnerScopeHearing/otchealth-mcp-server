// Pure request-parameter builders for the Twilio write tools. Kept free of any env/config import so
// they can be unit-tested without a configured gateway environment (loadEnv() throws in tests).

export interface IncomingPhoneNumberUpdateArgs {
  friendly_name?: string;
  sms_url?: string;
  sms_method?: 'GET' | 'POST';
  voice_url?: string;
  voice_method?: 'GET' | 'POST';
  status_callback?: string;
  status_callback_method?: 'GET' | 'POST';
  /** Twilio calls this when the primary VoiceUrl fails or returns invalid TwiML (2026-09-02: the
   *  signed n8n fallbacks on the recovered CS host). */
  voice_fallback_url?: string;
  voice_fallback_method?: 'GET' | 'POST';
  sms_fallback_url?: string;
  sms_fallback_method?: 'GET' | 'POST';
}

/** Pure mapping from the tool's snake_case input to Twilio's form parameters. Exported so the
 *  mapping is unit-testable without a network call; only PRESENT fields are sent, so an update that
 *  names only the fallback URLs never touches the primary voice/SMS routing. */
export function incomingPhoneNumberParams(args: IncomingPhoneNumberUpdateArgs): Record<string, string> {
  const params: Record<string, string> = {};
  if (args.friendly_name) params.FriendlyName = args.friendly_name;
  if (args.sms_url) params.SmsUrl = args.sms_url;
  if (args.sms_method) params.SmsMethod = args.sms_method;
  if (args.voice_url) params.VoiceUrl = args.voice_url;
  if (args.voice_method) params.VoiceMethod = args.voice_method;
  if (args.status_callback) params.StatusCallback = args.status_callback;
  if (args.status_callback_method) params.StatusCallbackMethod = args.status_callback_method;
  if (args.voice_fallback_url) params.VoiceFallbackUrl = args.voice_fallback_url;
  if (args.voice_fallback_method) params.VoiceFallbackMethod = args.voice_fallback_method;
  if (args.sms_fallback_url) params.SmsFallbackUrl = args.sms_fallback_url;
  if (args.sms_fallback_method) params.SmsFallbackMethod = args.sms_fallback_method;
  return params;
}

export interface MessagingServiceUpdateArgs {
  friendly_name?: string;
  inbound_request_url?: string;
  inbound_method?: 'GET' | 'POST';
  fallback_url?: string;
  fallback_method?: 'GET' | 'POST';
  status_callback?: string;
  use_inbound_webhook_on_number?: boolean;
}

/** Pure mapping for POST /v1/Services/{sid} (messaging.twilio.com). Exported for unit tests. */
export function messagingServiceParams(args: MessagingServiceUpdateArgs): Record<string, string> {
  const params: Record<string, string> = {};
  if (args.friendly_name) params.FriendlyName = args.friendly_name;
  if (args.inbound_request_url) params.InboundRequestUrl = args.inbound_request_url;
  if (args.inbound_method) params.InboundMethod = args.inbound_method;
  if (args.fallback_url) params.FallbackUrl = args.fallback_url;
  if (args.fallback_method) params.FallbackMethod = args.fallback_method;
  if (args.status_callback) params.StatusCallback = args.status_callback;
  if (typeof args.use_inbound_webhook_on_number === 'boolean') params.UseInboundWebhookOnNumber = String(args.use_inbound_webhook_on_number);
  return params;
}

