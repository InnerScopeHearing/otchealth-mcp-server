import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';

/**
 * agent_persona — serve a fleet agent's role definition so the SAME agent can be bootstrapped on
 * ANY platform (ChatGPT, Perplexity, Copilot, Claude, Hyperagent), not just the engines with a
 * native config. Personas are the PUBLIC role definitions in otchealth-claude-tools
 * (dream-team/agents/<agent>.md). Combined with memory_pack (durable working set) this gives a
 * cold client everything it needs to act as that agent.
 *
 * Ring-safe: serves only the public role-definition markdown. It does NOT expose any ledger, data,
 * secret, or sensitive-ring tool — sensitive exec personas (cto/cfo) are not in the public catalog
 * and intentionally stay on the trusted engines.
 */
const RAW_BASE = 'https://raw.githubusercontent.com/InnerScopeHearing/otchealth-claude-tools/main/dream-team/agents';

// Known public personas (mirrors dream-team/agents/). Listed for discovery; the fetch is the source of truth.
const KNOWN = [
  'architect', 'builder', 'capital', 'clo', 'coach', 'commerce', 'compliance-officer', 'coo',
  'creative', 'developer', 'digital-products', 'finance-ops', 'growth', 'growth-exposure',
  'guardian', 'lifecycle', 'medic', 'qa', 'rainmaker', 'release-captain', 'switchboard',
];

export function registerAgentPersona(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(
    server,
    {
      name: 'agent_persona',
      category: 'read',
      annotations: {
        title: 'Load an agent persona',
        description:
          'Fetch a fleet agent role definition (system prompt) so any platform can run that agent. Call with no agent to list available personas. Pair with memory_pack for full bootstrap (persona = who you are; pack = what you know). Public role definitions only; ring-safe.',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputShape: {
        agent: z.string().optional().describe('Agent id to load (e.g. "developer", "commerce", "guardian"). Omit to list available personas.'),
      },
      outputShape: {
        agent: z.string().optional(),
        persona: z.string().optional(),
        available: z.array(z.string()).optional(),
        error: z.string().optional(),
      },
      handler: async (input) => {
        if (!input.agent) {
          return { data: { available: KNOWN }, summary: `${KNOWN.length} personas available. Call agent_persona with one to load it.` };
        }
        const agent = input.agent.trim().toLowerCase();
        if (!/^[a-z0-9][a-z0-9_-]{0,40}$/.test(agent)) {
          return { data: { agent, error: 'invalid agent id' }, summary: `invalid agent id "${input.agent}".` };
        }
        const r = await fetch(`${RAW_BASE}/${encodeURIComponent(agent)}.md`);
        if (r.status === 404) {
          return {
            data: { agent, error: 'no public persona', available: KNOWN },
            summary: `No public persona for "${agent}". Sensitive exec personas (e.g. cto/cfo) stay on trusted engines.`,
          };
        }
        if (!r.ok) {
          return { data: { agent, error: `fetch ${r.status}` }, summary: `Failed to fetch persona for "${agent}" (${r.status}).` };
        }
        const persona = await r.text();
        return { data: { agent, persona }, summary: `Loaded persona for "${agent}" (${persona.length} chars).` };
      },
    },
    callerHash,
  );
}
