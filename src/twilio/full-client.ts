/**
 * Twilio + ElevenLabs Full Client
 *
 * Self-contained. Covers the complete resource surface:
 *   Messages, Calls, Recordings, Phone Numbers, Messaging Services,
 *   Call Feedback, Conferences, Queues, Transcriptions, Usage Records,
 *   and ElevenLabs (voices, TTS, models).
 *
 * Auth env vars reused — NO new vars added:
 *   TWILIO_ACCOUNT_SID  — Account SID
 *   TWILIO_AUTH_TOKEN   — Basic auth password
 *   TWILIO_FROM_NUMBER  — Default sender (outbound ops)
 *
 * ElevenLabs note: ELEVENLABS_API_KEY is NOT present in env.ts.
 * The ElevenLabs helpers check process.env.ELEVENLABS_API_KEY at runtime.
 * If absent they throw a clear error; callers should gracefully handle it.
 *
 * Twilio REST base: https://api.twilio.com/2010-04-01
 * ElevenLabs base:  https://api.elevenlabs.io/v1
 */

import { request } from 'undici';
import { loadEnv } from '../config/env.js';
import { TwilioApiError } from './api-client.js';

const env = loadEnv();

const TWILIO_BASE = 'https://api.twilio.com/2010-04-01';
const ELEVENLABS_BASE = 'https://api.elevenlabs.io/v1';

// ── Auth helpers ─────────────────────────────────────────────────────────────

function requireTwilioCreds(): { sid: string; token: string } {
  if (!env.TWILIO_ACCOUNT_SID) {
    throw new TwilioApiError({
      code: 'twilio_not_configured',
      status: 0,
      message: 'TWILIO_ACCOUNT_SID is not set.',
      nextStep: 'Add TWILIO_ACCOUNT_SID to the MCP server environment.',
    });
  }
  if (!env.TWILIO_AUTH_TOKEN) {
    throw new TwilioApiError({
      code: 'twilio_not_configured',
      status: 0,
      message: 'TWILIO_AUTH_TOKEN is not set.',
      nextStep: 'Add TWILIO_AUTH_TOKEN to the MCP server environment.',
    });
  }
  return { sid: env.TWILIO_ACCOUNT_SID, token: env.TWILIO_AUTH_TOKEN };
}

function basicAuth(creds: { sid: string; token: string }): string {
  return `Basic ${Buffer.from(`${creds.sid}:${creds.token}`, 'utf8').toString('base64')}`;
}

function requireElevenLabsKey(): string {
  const key = (process.env as Record<string, string | undefined>).ELEVENLABS_API_KEY ?? '';
  if (!key) {
    throw new TwilioApiError({
      code: 'elevenlabs_not_configured',
      status: 0,
      message: 'ELEVENLABS_API_KEY is not set in the environment.',
      nextStep: 'Add ELEVENLABS_API_KEY to the MCP server environment to enable ElevenLabs tools.',
    });
  }
  return key;
}

// ── Low-level request helpers ─────────────────────────────────────────────────

function mapTwilioError(status: number, path: string, data: any): TwilioApiError {
  const twilioCode = data?.code ? String(data.code) : String(status);
  const message = data?.message ?? `Twilio HTTP ${status} on ${path}`;
  if (status === 401 || status === 403) {
    return new TwilioApiError({
      code: 'twilio_auth_failed',
      status,
      message: `Twilio rejected auth on ${path}: ${message}`,
      nextStep: 'Verify TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN. Rotate if leaked.',
      upstream: data,
    });
  }
  if (status === 400) {
    return new TwilioApiError({
      code: `twilio_bad_request_${twilioCode}`,
      status,
      message: `Twilio rejected the request to ${path}: ${message}`,
      nextStep: 'Check https://www.twilio.com/docs/errors for the error code. Verify E.164 format and account permissions.',
      upstream: data,
    });
  }
  if (status === 404) {
    return new TwilioApiError({
      code: 'twilio_not_found',
      status,
      message: `Twilio resource not found at ${path}: ${message}`,
      nextStep: 'Verify the SID is correct and belongs to this account.',
      upstream: data,
    });
  }
  if (status === 429) {
    return new TwilioApiError({
      code: 'twilio_rate_limited',
      status,
      message: `Twilio rate-limited the call to ${path}.`,
      nextStep: 'Back off and retry. Check account sending limits.',
      upstream: data,
    });
  }
  if (status >= 500) {
    return new TwilioApiError({
      code: 'twilio_upstream_error',
      status,
      message: `Twilio returned ${status} for ${path}: ${message}`,
      nextStep: 'Check https://status.twilio.com/ and retry after a few minutes.',
      upstream: data,
    });
  }
  return new TwilioApiError({
    code: `twilio_${twilioCode}`,
    status,
    message: `Twilio returned ${status} for ${path}: ${message}`,
    nextStep: `Look up Twilio error code ${twilioCode} at https://www.twilio.com/docs/errors.`,
    upstream: data,
  });
}

async function twilioGet<T = unknown>(path: string): Promise<T> {
  const creds = requireTwilioCreds();
  const url = `${TWILIO_BASE}${path}`;
  let statusCode: number;
  let text: string;
  try {
    const res = await request(url, {
      method: 'GET',
      headers: { Authorization: basicAuth(creds), Accept: 'application/json' },
      headersTimeout: 30_000,
      bodyTimeout: 30_000,
    });
    statusCode = res.statusCode;
    text = await res.body.text();
  } catch (netErr) {
    throw new TwilioApiError({
      code: 'twilio_network_error',
      status: 0,
      message: `Network error calling Twilio GET ${path}: ${(netErr as Error).message}`,
      nextStep: 'Check https://status.twilio.com/. Retry if transient.',
      upstream: netErr,
    });
  }
  let data: any;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (statusCode >= 200 && statusCode < 300) return data as T;
  throw mapTwilioError(statusCode, path, data);
}

async function twilioPost<T = unknown>(path: string, params: Record<string, string>): Promise<T> {
  const creds = requireTwilioCreds();
  const url = `${TWILIO_BASE}${path}`;
  const body = new URLSearchParams(params).toString();
  let statusCode: number;
  let text: string;
  try {
    const res = await request(url, {
      method: 'POST',
      headers: {
        Authorization: basicAuth(creds),
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body,
      headersTimeout: 30_000,
      bodyTimeout: 30_000,
    });
    statusCode = res.statusCode;
    text = await res.body.text();
  } catch (netErr) {
    throw new TwilioApiError({
      code: 'twilio_network_error',
      status: 0,
      message: `Network error calling Twilio POST ${path}: ${(netErr as Error).message}`,
      nextStep: 'Check https://status.twilio.com/. Retry if transient.',
      upstream: netErr,
    });
  }
  let data: any;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (statusCode >= 200 && statusCode < 300) return data as T;
  throw mapTwilioError(statusCode, path, data);
}

async function twilioDelete(path: string): Promise<void> {
  const creds = requireTwilioCreds();
  const url = `${TWILIO_BASE}${path}`;
  let statusCode: number;
  let text: string;
  try {
    const res = await request(url, {
      method: 'DELETE',
      headers: { Authorization: basicAuth(creds), Accept: 'application/json' },
      headersTimeout: 30_000,
      bodyTimeout: 30_000,
    });
    statusCode = res.statusCode;
    text = await res.body.text();
  } catch (netErr) {
    throw new TwilioApiError({
      code: 'twilio_network_error',
      status: 0,
      message: `Network error calling Twilio DELETE ${path}: ${(netErr as Error).message}`,
      nextStep: 'Check https://status.twilio.com/. Retry if transient.',
      upstream: netErr,
    });
  }
  if (statusCode === 204 || statusCode === 200) return;
  let data: any;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  throw mapTwilioError(statusCode, path, data);
}

// ── ElevenLabs helper ─────────────────────────────────────────────────────────

async function elevenGet<T = unknown>(path: string): Promise<T> {
  const key = requireElevenLabsKey();
  const url = `${ELEVENLABS_BASE}${path}`;
  let statusCode: number;
  let text: string;
  try {
    const res = await request(url, {
      method: 'GET',
      headers: { 'xi-api-key': key, Accept: 'application/json' },
      headersTimeout: 30_000,
      bodyTimeout: 30_000,
    });
    statusCode = res.statusCode;
    text = await res.body.text();
  } catch (netErr) {
    throw new TwilioApiError({
      code: 'elevenlabs_network_error',
      status: 0,
      message: `Network error calling ElevenLabs GET ${path}: ${(netErr as Error).message}`,
      nextStep: 'Check https://status.elevenlabs.io/. Retry if transient.',
      upstream: netErr,
    });
  }
  let data: any;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (statusCode >= 200 && statusCode < 300) return data as T;
  throw new TwilioApiError({
    code: `elevenlabs_${statusCode}`,
    status: statusCode,
    message: data?.detail ?? `ElevenLabs HTTP ${statusCode} on ${path}`,
    nextStep: 'Check your ELEVENLABS_API_KEY and voice/model IDs at https://elevenlabs.io/docs.',
    upstream: data,
  });
}

async function elevenPostBinary(path: string, jsonBody: unknown): Promise<Buffer> {
  const key = requireElevenLabsKey();
  const url = `${ELEVENLABS_BASE}${path}`;
  let statusCode: number;
  let buffer: Buffer;
  try {
    const res = await request(url, {
      method: 'POST',
      headers: { 'xi-api-key': key, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
      body: JSON.stringify(jsonBody),
      headersTimeout: 60_000,
      bodyTimeout: 120_000,
    });
    statusCode = res.statusCode;
    const chunks: Uint8Array[] = [];
    for await (const chunk of res.body) {
      chunks.push(chunk as Uint8Array);
    }
    buffer = Buffer.concat(chunks);
  } catch (netErr) {
    throw new TwilioApiError({
      code: 'elevenlabs_network_error',
      status: 0,
      message: `Network error calling ElevenLabs POST ${path}: ${(netErr as Error).message}`,
      nextStep: 'Retry if transient. Check https://status.elevenlabs.io/.',
      upstream: netErr,
    });
  }
  if (statusCode >= 200 && statusCode < 300) return buffer;
  let errData: any;
  try { errData = JSON.parse(buffer.toString('utf8')); } catch { errData = { raw: buffer.toString('utf8') }; }
  throw new TwilioApiError({
    code: `elevenlabs_tts_${statusCode}`,
    status: statusCode,
    message: errData?.detail ?? `ElevenLabs TTS HTTP ${statusCode}`,
    nextStep: 'Verify voice_id, model_id, and your ELEVENLABS_API_KEY quota.',
    upstream: errData,
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// MESSAGES
// ═══════════════════════════════════════════════════════════════════════════════

export async function getMessage(messageSid: string): Promise<any> {
  const creds = requireTwilioCreds();
  return twilioGet(`/Accounts/${creds.sid}/Messages/${messageSid}.json`);
}

export async function deleteMessage(messageSid: string): Promise<void> {
  const creds = requireTwilioCreds();
  return twilioDelete(`/Accounts/${creds.sid}/Messages/${messageSid}.json`);
}

export async function listMessageMedia(messageSid: string): Promise<any[]> {
  const creds = requireTwilioCreds();
  const data = await twilioGet<{ media_list: any[] }>(
    `/Accounts/${creds.sid}/Messages/${messageSid}/Media.json`,
  );
  return data.media_list ?? [];
}

export async function redactMessageBody(messageSid: string): Promise<any> {
  const creds = requireTwilioCreds();
  return twilioPost(`/Accounts/${creds.sid}/Messages/${messageSid}.json`, { Body: '' });
}

// ═══════════════════════════════════════════════════════════════════════════════
// CALLS
// ═══════════════════════════════════════════════════════════════════════════════

export async function listCalls(args: {
  to?: string;
  from?: string;
  status?: string;
  page_size?: number;
}): Promise<any[]> {
  const creds = requireTwilioCreds();
  const qs = new URLSearchParams();
  if (args.to) qs.set('To', args.to);
  if (args.from) qs.set('From', args.from);
  if (args.status) qs.set('Status', args.status);
  qs.set('PageSize', String(args.page_size ?? 20));
  const data = await twilioGet<{ calls: any[] }>(
    `/Accounts/${creds.sid}/Calls.json?${qs.toString()}`,
  );
  return data.calls ?? [];
}

export async function getCall(callSid: string): Promise<any> {
  const creds = requireTwilioCreds();
  return twilioGet(`/Accounts/${creds.sid}/Calls/${callSid}.json`);
}

export async function updateCall(callSid: string, args: {
  status?: string;
  url?: string;
  method?: string;
}): Promise<any> {
  const creds = requireTwilioCreds();
  const params: Record<string, string> = {};
  if (args.status) params.Status = args.status;
  if (args.url) params.Url = args.url;
  if (args.method) params.Method = args.method;
  return twilioPost(`/Accounts/${creds.sid}/Calls/${callSid}.json`, params);
}

export async function deleteCall(callSid: string): Promise<void> {
  const creds = requireTwilioCreds();
  return twilioDelete(`/Accounts/${creds.sid}/Calls/${callSid}.json`);
}

export async function listCallRecordings(callSid: string): Promise<any[]> {
  const creds = requireTwilioCreds();
  const data = await twilioGet<{ recordings: any[] }>(
    `/Accounts/${creds.sid}/Calls/${callSid}/Recordings.json`,
  );
  return data.recordings ?? [];
}

// ═══════════════════════════════════════════════════════════════════════════════
// RECORDINGS
// ═══════════════════════════════════════════════════════════════════════════════

export async function listRecordings(args: {
  call_sid?: string;
  page_size?: number;
}): Promise<any[]> {
  const creds = requireTwilioCreds();
  const qs = new URLSearchParams();
  if (args.call_sid) qs.set('CallSid', args.call_sid);
  qs.set('PageSize', String(args.page_size ?? 20));
  const data = await twilioGet<{ recordings: any[] }>(
    `/Accounts/${creds.sid}/Recordings.json?${qs.toString()}`,
  );
  return data.recordings ?? [];
}

export async function getRecording(recordingSid: string): Promise<any> {
  const creds = requireTwilioCreds();
  return twilioGet(`/Accounts/${creds.sid}/Recordings/${recordingSid}.json`);
}

export async function deleteRecording(recordingSid: string): Promise<void> {
  const creds = requireTwilioCreds();
  return twilioDelete(`/Accounts/${creds.sid}/Recordings/${recordingSid}.json`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// PHONE NUMBERS — Incoming (owned)
// ═══════════════════════════════════════════════════════════════════════════════

export async function listIncomingPhoneNumbers(args: {
  phone_number?: string;
  friendly_name?: string;
  page_size?: number;
}): Promise<any[]> {
  const creds = requireTwilioCreds();
  const qs = new URLSearchParams();
  if (args.phone_number) qs.set('PhoneNumber', args.phone_number);
  if (args.friendly_name) qs.set('FriendlyName', args.friendly_name);
  qs.set('PageSize', String(args.page_size ?? 20));
  const data = await twilioGet<{ incoming_phone_numbers: any[] }>(
    `/Accounts/${creds.sid}/IncomingPhoneNumbers.json?${qs.toString()}`,
  );
  return data.incoming_phone_numbers ?? [];
}

export async function getIncomingPhoneNumber(phoneSid: string): Promise<any> {
  const creds = requireTwilioCreds();
  return twilioGet(`/Accounts/${creds.sid}/IncomingPhoneNumbers/${phoneSid}.json`);
}

export async function updateIncomingPhoneNumber(phoneSid: string, args: {
  friendly_name?: string;
  sms_url?: string;
  voice_url?: string;
  status_callback?: string;
}): Promise<any> {
  const creds = requireTwilioCreds();
  const params: Record<string, string> = {};
  if (args.friendly_name) params.FriendlyName = args.friendly_name;
  if (args.sms_url) params.SmsUrl = args.sms_url;
  if (args.voice_url) params.VoiceUrl = args.voice_url;
  if (args.status_callback) params.StatusCallback = args.status_callback;
  return twilioPost(`/Accounts/${creds.sid}/IncomingPhoneNumbers/${phoneSid}.json`, params);
}

export async function releasePhoneNumber(phoneSid: string): Promise<void> {
  const creds = requireTwilioCreds();
  return twilioDelete(`/Accounts/${creds.sid}/IncomingPhoneNumbers/${phoneSid}.json`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// PHONE NUMBERS — Available for purchase
// ═══════════════════════════════════════════════════════════════════════════════

export async function listAvailablePhoneNumbers(args: {
  country_code: string;
  type?: 'Local' | 'TollFree' | 'Mobile';
  area_code?: string;
  contains?: string;
  page_size?: number;
}): Promise<any[]> {
  const creds = requireTwilioCreds();
  const numberType = args.type ?? 'Local';
  const qs = new URLSearchParams();
  if (args.area_code) qs.set('AreaCode', args.area_code);
  if (args.contains) qs.set('Contains', args.contains);
  qs.set('PageSize', String(args.page_size ?? 20));
  const data = await twilioGet<{ available_phone_numbers: any[] }>(
    `/Accounts/${creds.sid}/AvailablePhoneNumbers/${args.country_code}/${numberType}.json?${qs.toString()}`,
  );
  return data.available_phone_numbers ?? [];
}

export async function buyPhoneNumber(args: {
  phone_number: string;
  friendly_name?: string;
  sms_url?: string;
  voice_url?: string;
}): Promise<any> {
  const creds = requireTwilioCreds();
  const params: Record<string, string> = { PhoneNumber: args.phone_number };
  if (args.friendly_name) params.FriendlyName = args.friendly_name;
  if (args.sms_url) params.SmsUrl = args.sms_url;
  if (args.voice_url) params.VoiceUrl = args.voice_url;
  return twilioPost(`/Accounts/${creds.sid}/IncomingPhoneNumbers.json`, params);
}

// ═══════════════════════════════════════════════════════════════════════════════
// MESSAGING SERVICES
// ═══════════════════════════════════════════════════════════════════════════════

export async function listMessagingServices(page_size = 20): Promise<any[]> {
  const creds = requireTwilioCreds();
  const data = await twilioGet<{ services: any[] }>(
    `/Accounts/${creds.sid}/Services.json?PageSize=${page_size}`,
  );
  return data.services ?? [];
}

export async function getMessagingService(serviceSid: string): Promise<any> {
  const creds = requireTwilioCreds();
  return twilioGet(`/Accounts/${creds.sid}/Services/${serviceSid}.json`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// CALL FEEDBACK
// ═══════════════════════════════════════════════════════════════════════════════

export async function getCallFeedback(callSid: string): Promise<any> {
  const creds = requireTwilioCreds();
  return twilioGet(`/Accounts/${creds.sid}/Calls/${callSid}/Feedback.json`);
}

export async function createCallFeedback(callSid: string, args: {
  quality_score: number;
  issue?: string[];
}): Promise<any> {
  const creds = requireTwilioCreds();
  const params: Record<string, string> = { QualityScore: String(args.quality_score) };
  if (args.issue && args.issue.length > 0) {
    // Twilio accepts repeated Issue[] params; only first is needed for URLSearchParams
    // For simplicity, join as repeating param via URLSearchParams append
    const parts: string[] = [];
    for (const [k, v] of Object.entries(params)) {
      parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
    }
    for (const iss of args.issue) {
      parts.push(`Issue=${encodeURIComponent(iss)}`);
    }
    // Use raw post path
    return _twilioPostRaw(`/Accounts/${creds.sid}/Calls/${callSid}/Feedback.json`, parts.join('&'));
  }
  return twilioPost(`/Accounts/${creds.sid}/Calls/${callSid}/Feedback.json`, params);
}

// Internal: post with pre-built body string (for multi-value params)
async function _twilioPostRaw<T = unknown>(path: string, body: string): Promise<T> {
  const creds = requireTwilioCreds();
  const url = `${TWILIO_BASE}${path}`;
  let statusCode: number;
  let text: string;
  try {
    const res = await request(url, {
      method: 'POST',
      headers: {
        Authorization: basicAuth(creds),
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body,
      headersTimeout: 30_000,
      bodyTimeout: 30_000,
    });
    statusCode = res.statusCode;
    text = await res.body.text();
  } catch (netErr) {
    throw new TwilioApiError({
      code: 'twilio_network_error',
      status: 0,
      message: `Network error calling Twilio POST ${path}: ${(netErr as Error).message}`,
      nextStep: 'Check https://status.twilio.com/. Retry if transient.',
      upstream: netErr,
    });
  }
  let data: any;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (statusCode >= 200 && statusCode < 300) return data as T;
  throw mapTwilioError(statusCode, path, data);
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONFERENCES
// ═══════════════════════════════════════════════════════════════════════════════

export async function listConferences(args: {
  status?: string;
  friendly_name?: string;
  page_size?: number;
}): Promise<any[]> {
  const creds = requireTwilioCreds();
  const qs = new URLSearchParams();
  if (args.status) qs.set('Status', args.status);
  if (args.friendly_name) qs.set('FriendlyName', args.friendly_name);
  qs.set('PageSize', String(args.page_size ?? 20));
  const data = await twilioGet<{ conferences: any[] }>(
    `/Accounts/${creds.sid}/Conferences.json?${qs.toString()}`,
  );
  return data.conferences ?? [];
}

export async function getConference(conferenceSid: string): Promise<any> {
  const creds = requireTwilioCreds();
  return twilioGet(`/Accounts/${creds.sid}/Conferences/${conferenceSid}.json`);
}

export async function updateConference(conferenceSid: string, args: {
  status?: string;
  announce_url?: string;
}): Promise<any> {
  const creds = requireTwilioCreds();
  const params: Record<string, string> = {};
  if (args.status) params.Status = args.status;
  if (args.announce_url) params.AnnounceUrl = args.announce_url;
  return twilioPost(`/Accounts/${creds.sid}/Conferences/${conferenceSid}.json`, params);
}

export async function listConferenceParticipants(conferenceSid: string, page_size = 20): Promise<any[]> {
  const creds = requireTwilioCreds();
  const data = await twilioGet<{ participants: any[] }>(
    `/Accounts/${creds.sid}/Conferences/${conferenceSid}/Participants.json?PageSize=${page_size}`,
  );
  return data.participants ?? [];
}

export async function updateConferenceParticipant(
  conferenceSid: string,
  callSid: string,
  args: {
    muted?: boolean;
    hold?: boolean;
    coaching?: boolean;
  },
): Promise<any> {
  const creds = requireTwilioCreds();
  const params: Record<string, string> = {};
  if (args.muted !== undefined) params.Muted = String(args.muted);
  if (args.hold !== undefined) params.Hold = String(args.hold);
  if (args.coaching !== undefined) params.Coaching = String(args.coaching);
  return twilioPost(
    `/Accounts/${creds.sid}/Conferences/${conferenceSid}/Participants/${callSid}.json`,
    params,
  );
}

export async function kickConferenceParticipant(
  conferenceSid: string,
  callSid: string,
): Promise<void> {
  const creds = requireTwilioCreds();
  return twilioDelete(
    `/Accounts/${creds.sid}/Conferences/${conferenceSid}/Participants/${callSid}.json`,
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// QUEUES
// ═══════════════════════════════════════════════════════════════════════════════

export async function listQueues(page_size = 20): Promise<any[]> {
  const creds = requireTwilioCreds();
  const data = await twilioGet<{ queues: any[] }>(
    `/Accounts/${creds.sid}/Queues.json?PageSize=${page_size}`,
  );
  return data.queues ?? [];
}

export async function getQueue(queueSid: string): Promise<any> {
  const creds = requireTwilioCreds();
  return twilioGet(`/Accounts/${creds.sid}/Queues/${queueSid}.json`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// TRANSCRIPTIONS
// ═══════════════════════════════════════════════════════════════════════════════

export async function listTranscriptions(page_size = 20): Promise<any[]> {
  const creds = requireTwilioCreds();
  const data = await twilioGet<{ transcriptions: any[] }>(
    `/Accounts/${creds.sid}/Transcriptions.json?PageSize=${page_size}`,
  );
  return data.transcriptions ?? [];
}

export async function getTranscription(transcriptionSid: string): Promise<any> {
  const creds = requireTwilioCreds();
  return twilioGet(`/Accounts/${creds.sid}/Transcriptions/${transcriptionSid}.json`);
}

export async function deleteTranscription(transcriptionSid: string): Promise<void> {
  const creds = requireTwilioCreds();
  return twilioDelete(`/Accounts/${creds.sid}/Transcriptions/${transcriptionSid}.json`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// USAGE RECORDS
// ═══════════════════════════════════════════════════════════════════════════════

export async function listUsageRecords(args: {
  category?: string;
  start_date?: string;
  end_date?: string;
  page_size?: number;
}): Promise<any[]> {
  const creds = requireTwilioCreds();
  const qs = new URLSearchParams();
  if (args.category) qs.set('Category', args.category);
  if (args.start_date) qs.set('StartDate', args.start_date);
  if (args.end_date) qs.set('EndDate', args.end_date);
  qs.set('PageSize', String(args.page_size ?? 50));
  const data = await twilioGet<{ usage_records: any[] }>(
    `/Accounts/${creds.sid}/Usage/Records.json?${qs.toString()}`,
  );
  return data.usage_records ?? [];
}

// ═══════════════════════════════════════════════════════════════════════════════
// ELEVENLABS
// ═══════════════════════════════════════════════════════════════════════════════

export async function elevenListVoices(): Promise<any[]> {
  const data = await elevenGet<{ voices: any[] }>('/voices');
  return data.voices ?? [];
}

export async function elevenGetVoice(voiceId: string): Promise<any> {
  return elevenGet(`/voices/${voiceId}`);
}

export async function elevenListModels(): Promise<any[]> {
  return elevenGet<any[]>('/models');
}

export interface ElevenTtsArgs {
  voice_id: string;
  text: string;
  model_id?: string;
  stability?: number;
  similarity_boost?: number;
  style?: number;
  use_speaker_boost?: boolean;
}

/**
 * Returns base64-encoded MP3 audio so it can be safely transported as JSON.
 */
export async function elevenTextToSpeech(args: ElevenTtsArgs): Promise<{
  audio_base64: string;
  content_type: string;
}> {
  const body: Record<string, unknown> = {
    text: args.text,
    model_id: args.model_id ?? 'eleven_monolingual_v1',
    voice_settings: {
      stability: args.stability ?? 0.5,
      similarity_boost: args.similarity_boost ?? 0.75,
      style: args.style ?? 0,
      use_speaker_boost: args.use_speaker_boost ?? true,
    },
  };
  const buffer = await elevenPostBinary(`/text-to-speech/${args.voice_id}`, body);
  return {
    audio_base64: buffer.toString('base64'),
    content_type: 'audio/mpeg',
  };
}
