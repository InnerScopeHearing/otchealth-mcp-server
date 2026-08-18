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

import {
  __resetHyperagentTokenLockForTests,
  getAccessToken as getStoredAccessToken,
  hyperagentConfigured as tokenStoreConfigured,
} from './token-store.js';

const MCP_ENDPOINT = 'https://hyperagent.com/api/mcp';

export function hyperagentConfigured(): boolean {
  return tokenStoreConfigured();
}

/** Reset module state. Test-only seam; never called in production paths. */
export function __resetHyperagentClientForTests(): void {
  __resetHyperagentTokenLockForTests();
}

/**
 * Mint (or reuse) an access token.
 *
 * ROTATION USED TO BE HANDLED HERE, IN MEMORY, AND THAT WAS WRONG. Hyperagent's refresh tokens are
 * single-use (verified live 2026-08-18) and its access tokens last ~15 minutes, so at the live
 * replica count each replica refreshes several times an hour. An in-memory rotation meant one
 * replica silently invalidated the other's token, and any redeploy dropped both back to a spent
 * value. Under reuse detection that can revoke the whole family and cost a fresh human consent.
 * Token lifecycle now lives in token-store.ts, which persists every rotation under an ETag'd
 * compare-and-swap before the token is used. See that file for the full reasoning.
 */
export async function getAccessToken(): Promise<string | null> {
  return getStoredAccessToken();
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
