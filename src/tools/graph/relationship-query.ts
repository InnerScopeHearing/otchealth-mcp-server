import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { createRelationshipPublicationDiscoveryService, type RelationshipPublicationDiscoveryService } from '../../server/relationship-publication.js';
import { isConnectorSurface } from '../../server/request-context.js';
import { registerTool, type CallerHashProvider } from '../registry.js';

const candidateQuery = z.object({
  kind: z.literal('candidate_links'),
  subject_name: z.string().min(1).max(1200).optional(),
  object_name: z.string().min(1).max(1200).optional(),
  predicate: z.string().min(1).max(1200).optional(),
  offset: z.number().int().min(0).max(400).optional(),
  limit: z.number().int().min(1).max(100).optional(),
  include_stale: z.boolean().optional(),
}).strict();
const verifiedQuery = z.object({
  subject_id: z.string().min(1).max(1200),
  object_id: z.string().min(1).max(1200),
  premise_ids: z.array(z.string().min(1).max(1200)).min(1).max(4).nullable().optional(),
  as_of_recorded: z.string().datetime().optional(),
  valid_at: z.string().datetime().nullable().optional(),
}).strict();

export function registerCfoRelationshipQuery(
  server: McpServer,
  callerHash: CallerHashProvider,
  injected?: RelationshipPublicationDiscoveryService,
): void {
  let service = injected;
  registerTool(server, {
    name: 'graph_relationship_query',
    category: 'read',
    annotations: {
      title: 'Query current CFO relationship publication history',
      description: 'CFO-only query over server-discovered immutable relationship publications. Candidate name matches stay explicitly unverified. Verified X-to-Y-to-Z dependency paths require a complete bounded scan plus fresh source and identity proof checks. The server pages storage reads in groups of at most 64 and scans at most 256 histories; next_after and an incomplete answer are returned when more history remains.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputShape: {
      cohort_id: z.string().min(1).max(96),
      producer_id: z.string().min(1).max(64),
      scope: z.literal('finance').optional(),
      after: z.string().regex(/^run_[a-f0-9]{64}$/).optional(),
      scan_limit: z.number().int().min(1).max(64).optional(),
      history_limit: z.number().int().min(1).max(256).optional(),
      query: z.union([candidateQuery, verifiedQuery]),
    },
    outputShape: {
      result: z.unknown().nullable(),
      error: z.string().optional(),
    },
    handler: async (input, ctx) => {
      if (ctx.callerAgent !== 'cfo' || !isConnectorSurface()) {
        return { data: { result: null, error: 'forbidden_cfo_only' }, summary: 'Refused: this relationship query is restricted to the authenticated CFO connector.' };
      }
      service ??= createRelationshipPublicationDiscoveryService();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 45_000);
      const auth = () => ({ caller_agent: ctx.callerAgent, caller_hash: ctx.callerHash, raw_token: '', connector_surface: isConnectorSurface(), m365_static_auth: false });
      const initial = auth();
      try {
        const result = await service.query(input, initial, controller.signal, async () => {
          const current = auth();
          if (current.caller_agent !== initial.caller_agent || current.caller_hash !== initial.caller_hash || !current.connector_surface) throw Object.assign(Error('relationship_publication_denied'), { status: 403 });
        });
        return { data: { result }, summary: `Scanned ${String(result.discovery?.scanned_histories ?? 0)} immutable publication histories. Candidate results remain unverified unless the answer itself reports a qualified path.` };
      } finally {
        clearTimeout(timer);
        controller.abort();
      }
    },
  }, callerHash);
}
