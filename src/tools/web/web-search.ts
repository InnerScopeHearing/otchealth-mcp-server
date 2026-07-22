/**
 * web_search — open-web research for gateway-connected agents. Self-contained + additive.
 * Calls the Azure AI Foundry project Responses API with Microsoft-managed Grounding-with-Bing
 * (`{type:'web_search'}`), using an Entra (AAD) token minted from a dedicated service principal.
 * Reads its own env only (WEBSEARCH_*) — touches nothing else; inert (returns 'unconfigured') when unset.
 * Company/PHI queries must stay on brain_search (web search leaves the compliance boundary).
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { fetchWithBudget } from '../../util/fetch-budget.js';
import { evaluateBroadcastMnpiGate } from '../../safety/mnpi-gate.js';

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

export function registerWebSearch(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(
    server,
    {
      name: 'web_search',
      category: 'read',
      annotations: {
        title: 'Open-web research (Grounding with Bing, read-only)',
        description:
          'Search the public web and return a grounded answer with source citations. Use for external/public-world topics only (news, market/competitor data, regulations, general research). NEVER pass company-confidential, personal, legal, customer, or PHI content here — use brain_search for those. Read-only. MNPI GATE (hard, code-level): the query is scanned for an EXEC_RING-gated room reference or an explicit MNPI marker BEFORE the request leaves the gateway; a match is refused for every caller, no exception (the public web is never a legitimate destination for that content).',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      inputShape: { query: z.string().min(1).describe('Public-world research query.') },
      outputShape: { answer: z.string(), citations: z.array(z.unknown()), mode: z.string(), error: z.string().optional() },
      handler: async (input) => {
        // MNPI DETERMINISTIC PRE-SHARE GATE (Wave 3 item 3.5, safety/mnpi-gate.ts). Runs BEFORE the
        // query ever leaves the gateway. The public web is, by construction, always external/non-
        // privileged: a match is a HARD BLOCK for every caller, no EXEC_RING exception.
        const mnpiGate = evaluateBroadcastMnpiGate({ query: input.query });
        if (mnpiGate.blocked) {
          return { data: { answer: '', citations: [], mode: 'blocked', error: mnpiGate.reason }, summary: `Refused: ${mnpiGate.reason}` };
        }
        const ep = (process.env.WEBSEARCH_PROJECT_ENDPOINT || '').replace(/\/+$/, '');
        const model = process.env.WEBSEARCH_MODEL || 'gpt-5.4';
        if (!ep || !process.env.WEBSEARCH_SP_CLIENT_ID || !process.env.WEBSEARCH_SP_SECRET) {
          return { data: { answer: '', citations: [], mode: 'unconfigured' }, summary: 'Web search not configured.' };
        }
        let token: string;
        try { token = await aad(); } catch (e) {
          return { data: { answer: '', citations: [], mode: 'error', error: String((e as Error).message) }, summary: 'Web search auth failed.' };
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
            input: input.query,
            tools: [{ type: 'web_search' }],
            tool_choice: 'auto',
            stream: false,
          }),
          });
        } catch (e) {
          return { data: { answer: '', citations: [], mode: 'error', error: 'web_search timeout' }, summary: 'Web search timed out.' };
        } finally { clearTimeout(to); }
        if (!r.ok) {
          const t = await r.text().catch(() => '');
          return { data: { answer: '', citations: [], mode: 'error', error: `responses ${r.status}` }, summary: `Web search failed: ${r.status} ${t.slice(0, 120)}` };
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
        return { data: { answer: answer.slice(0, 4000), citations, mode: 'web' }, summary: `Web search: ${citations.length} source(s).` };
      },
    },
    callerHash,
  );
}
