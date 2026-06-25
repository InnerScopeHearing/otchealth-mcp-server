import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { allTools, SERVICE_CATALOG, EXTRA_SERVICES, SKILLS, PLUGINS, SKILLS_REPO } from '../../catalog/catalog.js';
import { requiredRoleFor, GOVERNANCE } from '../../catalog/governance.js';

/**
 * catalog_master — the single self-describing inventory for EVERY agent on EVERY platform.
 * Returns every wired tool (with its governance RULE), every fleet service (wired + planned, with
 * ring/auth/rule), the full skills + plugins list, and the governance policy. This is how a new or
 * existing agent on ChatGPT/Perplexity/Copilot/Claude understands the complete toolset without any
 * native connector setup. Read catalog_skill(name) for a specific skill's how-to.
 */
export function registerCatalogMaster(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(
    server,
    {
      name: 'catalog_master',
      category: 'read',
      annotations: {
        title: 'Master capability catalog',
        description:
          'The complete fleet inventory: every wired tool (with its execution RULE/role gate), every service (wired + planned, with ring/auth), and all skills + plugins. Call this to understand everything available through the gateway. Rules are advisory documentation here AND enforced at call time for role-gated tools.',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputShape: {
        section: z.enum(['all', 'tools', 'services', 'skills', 'plugins', 'governance']).optional().describe('Limit to one section (default all).'),
      },
      outputShape: {
        tools: z.array(z.unknown()).optional(),
        services: z.array(z.unknown()).optional(),
        skills: z.array(z.string()).optional(),
        plugins: z.array(z.string()).optional(),
        governance: z.array(z.unknown()).optional(),
        skills_repo: z.string().optional(),
        counts: z.unknown(),
      },
      handler: async (input) => {
        const section = input.section ?? 'all';
        const tools = allTools().map((t) => {
          const g = requiredRoleFor(t.name);
          return {
            name: t.name,
            service: t.service,
            category: t.category,
            readOnly: t.readOnly,
            title: t.title,
            description: t.description,
            rule: g ? `EXECUTE requires role=${g.role}: ${g.reason}` : 'all agents may execute (subject to write-mode gating)',
          };
        });
        const services = Object.entries({ ...SERVICE_CATALOG, ...EXTRA_SERVICES }).map(([k, v]) => ({
          service: k,
          description: v.description,
          ring: v.ring,
          auth: v.auth,
          status: v.status,
          rule: v.rule ?? 'no special role gate',
          available_not_yet_wired: v.available,
        }));
        const counts = { tools: tools.length, services: services.length, skills: SKILLS.length, plugins: PLUGINS.length, governance_rules: GOVERNANCE.length };
        const full = { tools, services, skills: SKILLS, plugins: PLUGINS, governance: GOVERNANCE, skills_repo: SKILLS_REPO, counts };
        const data =
          section === 'all'
            ? full
            : section === 'tools' ? { tools, counts }
            : section === 'services' ? { services, counts }
            : section === 'skills' ? { skills: SKILLS, skills_repo: SKILLS_REPO, counts }
            : section === 'plugins' ? { plugins: PLUGINS, counts }
            : { governance: GOVERNANCE, counts };
        return { data, summary: `Master catalog: ${counts.tools} tools, ${counts.services} services, ${counts.skills} skills, ${counts.plugins} plugins, ${counts.governance_rules} governance rules.` };
      },
    },
    callerHash,
  );
}
