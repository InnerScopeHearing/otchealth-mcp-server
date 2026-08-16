/**
 * Azure provider for web_search (src/tools/web/web-search.ts's WEB_SEARCH_PROVIDER dispatcher,
 * default value). Calls the Azure AI Foundry project Responses API with Microsoft-managed
 * Grounding-with-Bing (`{type:'web_search'}`), using an Entra (AAD) token minted from a dedicated
 * service principal.
 *
 * BYTE-IDENTICAL EXTRACTION for the search behavior itself: same env vars, same URL construction,
 * same AAD token cache, same 60s timeout, same 4000-char answer cap, same annotation-parsing loop. A
 * deploy with WEB_SEARCH_PROVIDER unset (the default) runs the exact same request/response handling
 * as every deploy before this dispatcher existed.
 *
 * ONE deliberate, non-behavioral change: the truncated HTTP-error response body (`t.slice(0,120)`)
 * used to appear only in the tool's free-text `summary` field, built inline in the original
 * single-file handler. Now that `summary` is built generically by the dispatcher (web-search.ts,
 * shared across every provider) from this module's returned `error` string, that body snippet is
 * folded INTO `error` instead so the information is not lost. `error`'s exact text is therefore
 * slightly richer than before (`responses ${status}: ${body}` vs. previously just `responses
 * ${status}`); nothing structural (which endpoint, which auth, which fields) changed.
 *
 * Deliberately still reads process.env.WEBSEARCH_* DIRECTLY rather than through loadEnv()/
 * config/env.ts, preserving the original file's "self-contained, touches nothing else" property for
 * THIS provider specifically. The new provider-selection flag (WEB_SEARCH_PROVIDER) and the new
 * provider's own secret (TAVILY_API_KEY) DO go through the Zod schema, matching every other
 * *_PROVIDER/*_BACKEND flag in config/env.ts -- only this pre-existing Azure path is exempt, and
 * only so extracting it into its own file changes nothing about how it resolves its own config.
 */
import { fetchWithBudget } from '../../../util/fetch-budget.js';
import type { WebSearchResult } from './types.js';

let tok: { v: string; exp: number } = { v: '', exp: 0 };
async function aad(): Promise<string> {
  const now = Date.now();
  if (tok.v && tok.exp - now > 60_000) return tok.v;
  const tid = process.env.WEBSEARCH_SP_TENANT_ID || '';
  const cid = process.env.WEBSEARCH_SP_CLIENT_ID || '';
  const sec = process.env.WEBSEARCH_SP_SECRET || '';
  const r = await fetchWithBudget(`https://login.microsoftonline.com/${tid}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: cid, client_secret: sec, grant_type: 'client_credentials', scope: 'https://ai.azure.com/.default' }),
  });
  const j = (await r.json()) as { access_token?: string; expires_in?: number; error?: string };
  if (!j.access_token) throw new Error(`aad token: ${j.error || r.status}`);
  tok = { v: j.access_token, exp: now + (j.expires_in || 3600) * 1000 };
  return tok.v;
}

/** Reset the in-process AAD token cache. Test-only (there is no legitimate production reason to
 *  force a re-mint before natural expiry); exported so the test suite can assert the auth flow runs
 *  again under a fresh scenario without depending on wall-clock timing. */
export function __resetAadTokenCacheForTests(): void {
  tok = { v: '', exp: 0 };
}

export function azureWebSearchConfigured(): boolean {
  const ep = process.env.WEBSEARCH_PROJECT_ENDPOINT || '';
  return Boolean(ep && process.env.WEBSEARCH_SP_CLIENT_ID && process.env.WEBSEARCH_SP_SECRET);
}

export async function azureWebSearch(query: string): Promise<WebSearchResult> {
  const ep = (process.env.WEBSEARCH_PROJECT_ENDPOINT || '').replace(/\/+$/, '');
  const model = process.env.WEBSEARCH_MODEL || 'gpt-5.4';
  if (!azureWebSearchConfigured()) {
    return { answer: '', citations: [], mode: 'unconfigured' };
  }
  let token: string;
  try {
    token = await aad();
  } catch (e) {
    return { answer: '', citations: [], mode: 'error', error: String((e as Error).message) };
  }
  const ac = new AbortController();
  const to = setTimeout(() => ac.abort(), 60_000); // web search legitimately takes 20-40s
  let r: Response;
  try {
    r = await fetch(`${ep}/openai/v1/responses`, {
      method: 'POST',
      signal: ac.signal,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        instructions: 'Search the public web and answer concisely with inline source citations (include source URLs). Public-world information only.',
        input: query,
        tools: [{ type: 'web_search' }],
        tool_choice: 'auto',
        stream: false,
      }),
    });
  } catch (e) {
    return { answer: '', citations: [], mode: 'error', error: 'web_search timeout' };
  } finally {
    clearTimeout(to);
  }
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    return { answer: '', citations: [], mode: 'error', error: `responses ${r.status}: ${t.slice(0, 120)}` };
  }
  const j = (await r.json()) as any;
  let answer = typeof j.output_text === 'string' ? j.output_text : '';
  const citations: unknown[] = [];
  for (const item of j.output || []) {
    if (item.type === 'message') {
      for (const c of item.content || []) {
        if (c.type === 'output_text') {
          if (!answer) answer += c.text || '';
          for (const a of c.annotations || []) if (a.url || a.title) citations.push({ title: a.title, url: a.url });
        }
      }
    }
  }
  return { answer: answer.slice(0, 4000), citations, mode: 'web' };
}
