/** Validates successful Twilio list payloads without retaining provider text in errors. */
export function requireTwilioCollection(payload: unknown, key: string): any[] {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new TypeError('Twilio returned a malformed list response.');
  }
  const collection = (payload as Record<string, unknown>)[key];
  if (!Array.isArray(collection)) {
    throw new TypeError('Twilio returned a malformed list response.');
  }
  return collection;
}
