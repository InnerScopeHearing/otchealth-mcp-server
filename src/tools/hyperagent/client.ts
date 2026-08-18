/**
 * Hyperagent broker — credential + transport.
 *
 * WHY A BROKER AND NOT A DIRECT CONNECTION PER AGENT. Hyperagent's OAuth metadata advertises
 * `grant_types_supported: ['authorization_code', 'refresh_token']` and NO `client_credentials`, so a
 * server cannot authenticate itself: every connection is user-delegated through a browser consent.
 * It does advertise the `offline_access` scope, which yields a refresh token. So the shape that
 * works is exactly the one this fleet already runs for OneDrive (`graph-onedrive-refresh-token`,
 * which exists because that tenant blocks app-only auth): ONE human consent, captured once, then the
 * gateway mints access tokens from the refresh token indefinitely.
 *
 * That single credential is what makes per-lane gating possible at all — see ring.ts. Hyperagent
 * cannot express "this client may only reach these agents", so the gateway expresses it instead.
 */

import { loadEnv } from '../../config/env.js';

const TOKEN_ENDPOINT = 'https://hyperagent.com/api/oauth/token';
const MCP_ENDPOINT = 'https://hyperagent.com/api/mcp';

/** Refresh a little early so a token cannot expire between the check and the call it authorizes. */
const EXPIRY_SKEW_MS = 60_000;

interface CachedToken {
  accessToken: string;
  expiresAt: number;
}

let cache: CachedToken | null = null;

/**
 * The refresh token currently in use. Seeded from configuration, then REPLACED IN MEMORY if the
 * provider rotates it on use.
 *
 * ROTATION IS THE SHARP EDGE HERE, so it is handled explicitly rather than hoped about. If
 * Hyperagent returns a new `refresh_token` in a refresh response, the configured one is now spent.
 * Keeping the new one in memory keeps THIS process working, but a restart would fall back to the
 * spent value and the broker would go dark — the classic "worked until it was redeployed" failure.
 * `rotationPending` records that divergence so a health surface can report it loudly instead of it
 * being discovered weeks later.
 */
let activeRefreshToken: string | null = null;
let rotationPending = false;

/** True once the provider has handed us a refresh token that is not the configured one. */
export function refreshTokenRotationPending(): boolean {
  return rotationPending;
}

export function hyperagentConfigured(): boolean {
  return Boolean(loadEnv().HYPERAGENT_CLIENT_ID && loadEnv().HYPERAGENT_REFRESH_TOKEN);
}

/** Reset module state. Test-only seam; never called in production paths. */
export function __resetHyperagentClientForTests(): void {
  cache = null;
  activeRefreshToken = null;
  rotationPending = false;
}

/**
 * Mint (or reuse) an access token. Never logs, returns, or embeds the token in an error message —
 * errors carry status codes and provider error CODES only, never the bodies that might echo a
 * credential back.
 */
export async function getAccessToken(): Promise<string | null> {
  if (!hyperagentConfigured()) return null;

  const now = Date.now();
  if (cache && cache.expiresAt - EXPIRY_SKEW_MS > now) return cache.accessToken;

  const refresh = activeRefreshToken ?? loadEnv().HYPERAGENT_REFRESH_TOKEN ?? '';
  if (!refresh) return null;

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refresh,
    client_id: loadEnv().HYPERAGENT_CLIENT_ID ?? '',
  });
  // A public client registered via DCR has no secret; a confidential one does. Send it only if set.
  if (loadEnv().HYPERAGENT_CLIENT_SECRET) body.set('client_secret', loadEnv().HYPERAGENT_CLIENT_SECRET);

  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!res.ok) {
    // Deliberately status-only. A token endpoint's error body can contain the submitted credential.
    throw new Error(`hyperagent token refresh failed: HTTP ${res.status}`);
  }

  const json = (await res.json().catch(() => null)) as {
    access_token?: string;
    expires_in?: number;
    refresh_token?: string;
  } | null;

  if (!json?.access_token) throw new Error('hyperagent token refresh returned no access_token');

  if (json.refresh_token && json.refresh_token !== refresh) {
    activeRefreshToken = json.refresh_token;
    if (!rotationPending) {
      rotationPending = true;
      // Loud, once, and without the value. Silence here is how a broker dies at the next deploy.
      console.error(
        '[hyperagent] ROTATION: the provider issued a NEW refresh token. It is held in memory only. ' +
          'Persist it to the hyperagent-refresh-token secret before the next restart, or this broker ' +
          'will go dark when this process is replaced.',
      );
    }
  }

  const ttlMs = (json.expires_in ?? 3600) * 1000;
  cache = { accessToken: json.access_token, expiresAt: now + ttlMs };
  return json.access_token;
}

export interface McpCallResult {
  ok: boolean;
  status: number;
  /** Parsed tool result payload, when the provider returned one. */
  data: unknown;
  error?: string;
}

/**
 * Call one tool on Hyperagent's MCP server. Thin on purpose: every authorization decision belongs in
 * ring.ts and the tool wrappers, so this function stays a transport and cannot become a second,
 * divergent place where access is decided.
 */
export async function callHyperagentTool(name: string, args: Record<string, unknown>): Promise<McpCallResult> {
  const token = await getAccessToken();
  if (!token) return { ok: false, status: 0, data: null, error: 'unconfigured' };

  const res = await fetch(MCP_ENDPOINT, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });

  const text = await res.text();
  if (!res.ok) {
    return { ok: false, status: res.status, data: null, error: `HTTP ${res.status}` };
  }

  // The endpoint may answer as JSON or as an SSE frame; accept both rather than assuming.
  let payload: unknown = null;
  try {
    payload = JSON.parse(text);
  } catch {
    const line = text.split('\n').find((l) => l.startsWith('data:'));
    if (line) {
      try {
        payload = JSON.parse(line.slice(5).trim());
      } catch {
        /* fall through to the shape check below */
      }
    }
  }

  const rpc = payload as { result?: { content?: Array<{ type: string; text?: string }> }; error?: { message?: string } } | null;
  if (rpc?.error) return { ok: false, status: res.status, data: null, error: rpc.error.message ?? 'provider error' };

  // MCP wraps tool output in content[]; unwrap a single text block when it parses as JSON, since
  // every caller here wants structured data rather than a string of JSON.
  const first = rpc?.result?.content?.[0];
  if (first?.type === 'text' && typeof first.text === 'string') {
    try {
      return { ok: true, status: res.status, data: JSON.parse(first.text) };
    } catch {
      return { ok: true, status: res.status, data: first.text };
    }
  }
  return { ok: true, status: res.status, data: rpc?.result ?? null };
}
