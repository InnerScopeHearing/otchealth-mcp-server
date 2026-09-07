import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ingestSyntheticFixture, type RelationshipServiceDeps } from '../../relationships/service.js';
import { registerTool, type CallerHashProvider, type ToolContext } from '../registry.js';

const FixtureIdSchema = z.enum(['alpha_depends_beta', 'beta_depends_gamma', 'alpha_candidate_delta', 'alpha_depends_zeta_correction', 'retract_alpha_zeta']);
export interface RelationshipPilotIngestInput { fixture_id: z.infer<typeof FixtureIdSchema>; idempotency_key: string; }
export async function handleRelationshipPilotIngest(input: RelationshipPilotIngestInput, ctx: ToolContext, deps?: RelationshipServiceDeps) {
  const result = await ingestSyntheticFixture({ fixtureId: input.fixture_id, idempotencyKey: input.idempotency_key }, ctx, deps);
  return { data: result, summary: result.persisted === null ? 'UNKNOWN: the event write may have committed. Retry the same fixture and idempotency key.' : result.persisted ? (result.projected ? 'Synthetic relationship event persisted and projected.' : 'Synthetic relationship event persisted, but projection rebuild failed.') : 'DRY RUN: synthetic relationship event was not persisted.', audit: result.persisted ? { after: result } : undefined };
}
export function registerRelationshipPilotIngest(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'relationship_pilot_ingest_fixture',
    category: 'write_simple',
    annotations: {
      title: 'Ingest a synthetic relationship fixture',
      description: 'CTO-only disabled-by-default pilot. Persist one fixed harmless synthetic relationship event with a retry-stable idempotency key, then rebuild its immutable S3 projection. Tool input cannot select authority, storage, evidence, or transaction time. Pass dry_run=false to write.',
      readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false,
    },
    inputShape: {
      fixture_id: FixtureIdSchema.describe('Fixed harmless synthetic fixture identifier.'),
      idempotency_key: z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/).describe('Stable key for retries of this exact fixture operation.'),
    },
    outputShape: { persisted: z.boolean().nullable(), projected: z.boolean(), replayed: z.boolean().optional(), event_id: z.string(), relationship_id: z.string().optional() },
    handler: handleRelationshipPilotIngest,
  }, callerHash);
}
