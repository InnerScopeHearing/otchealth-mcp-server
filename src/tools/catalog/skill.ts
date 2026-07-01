import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { SKILLS } from '../../catalog/catalog.js';

/**
 * catalog_skill — fetch a fleet skill's how-to (its SKILL.md) so any agent on any platform can
 * learn to use a skill on demand. No arg -> list all skill names. With name -> the SKILL.md text.
 * Public repo content only (ring-safe).
 */
const RAW_BASE = 'https://raw.githubusercontent.com/InnerScopeHearing/otchealth-claude-tools/main/skills';

export function registerCatalogSkill(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(
    server,
    {
      name: 'catalog_skill',
      category: 'read',
      annotations: {
        title: 'Load a skill how-to',
        description:
          'Fetch a fleet skill SKILL.md (how to use it, what it does) on demand. No arg lists all skills; with a name returns that skill’s documentation. Pairs with catalog_master (which lists what exists). Public skills only.',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputShape: {
        name: z.string().optional().describe('Skill name (e.g. "release-conductor", "datadog"). Omit to list all skills.'),
      },
      outputShape: {
        name: z.string().optional(),
        doc: z.string().optional(),
        skills: z.array(z.string()).optional(),
        error: z.string().optional(),
      },
      handler: async (input) => {
        if (!input.name) {
          return { data: { skills: SKILLS }, summary: `${SKILLS.length} skills. Call catalog_skill with a name to load its how-to.` };
        }
        const name = input.name.trim().toLowerCase();
        if (!/^[a-z0-9][a-z0-9_-]{0,60}$/.test(name)) {
          return { data: { name, error: 'invalid skill name' }, summary: `invalid skill name "${input.name}".` };
        }
        const r = await fetch(`${RAW_BASE}/${encodeURIComponent(name)}/SKILL.md`);
        if (r.status === 404) {
          return { data: { name, error: 'not found', skills: SKILLS }, summary: `No skill "${name}". See the skills list.` };
        }
        if (!r.ok) {
          return { data: { name, error: `fetch ${r.status}` }, summary: `Failed to fetch skill "${name}" (${r.status}).` };
        }
        const doc = await r.text();
        return { data: { name, doc }, summary: `Loaded SKILL.md for "${name}" (${doc.length} chars).` };
      },
    },
    callerHash,
  );
}
