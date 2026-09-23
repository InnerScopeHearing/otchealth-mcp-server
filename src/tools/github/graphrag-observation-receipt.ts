import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { PINNED_GRAPHRAG_OBSERVATION } from '../../github/graphrag-observation-receipt.js';
import { getPinnedGraphRagObservationReceipt } from '../../github/full-client.js';
import { assertRepoAllowed } from '../../github/api-client.js';
import { registerTool, type CallerHashProvider } from '../registry.js';

const PROGRESS_STATISTIC_NAMES = [
  'numberOfDocumentsDeleted',
  'numberOfDocumentsFailed',
  'numberOfDocumentsScanned',
  'numberOfDocumentsSkipped',
  'numberOfMetadataDocumentsModified',
  'numberOfMetadataDocumentsScanned',
  'numberOfModifiedDocumentsIndexed',
  'numberOfNewDocumentsIndexed',
] as const;

const statisticValue = z.number().int().nonnegative();
const progressStatistics = z.record(z.enum(PROGRESS_STATISTIC_NAMES), statisticValue).nullable();
const terminalStatistics = z.object({
  numberOfDocumentsScanned: statisticValue,
  numberOfNewDocumentsIndexed: statisticValue,
  numberOfModifiedDocumentsIndexed: statisticValue,
  numberOfDocumentsDeleted: statisticValue,
  numberOfDocumentsFailed: statisticValue,
}).strict().nullable();

export function registerGitHubGraphRagObservationReceipt(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'github_graphrag_observation_receipt_get',
    category: 'read',
    annotations: {
      title: 'GitHub: validate pinned GraphRAG observation receipt',
      description: 'Read and structurally validate one fixed historical GraphRAG provider observation receipt from GitHub. No source documents or content are returned.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {},
    outputShape: {
      schema: z.literal(PINNED_GRAPHRAG_OBSERVATION.resultSchema),
      repository: z.literal(PINNED_GRAPHRAG_OBSERVATION.repository),
      run_id: z.literal(PINNED_GRAPHRAG_OBSERVATION.runId),
      artifact_id: z.literal(PINNED_GRAPHRAG_OBSERVATION.artifactId),
      artifact_name: z.literal(PINNED_GRAPHRAG_OBSERVATION.artifactName),
      receipt_schema: z.literal(PINNED_GRAPHRAG_OBSERVATION.receiptSchema),
      knowledge_base_binding_verified: z.literal(true),
      read_only: z.literal(true),
      source_id: z.literal(PINNED_GRAPHRAG_OBSERVATION.sourceId),
      ingestion_job_id: z.literal(PINNED_GRAPHRAG_OBSERVATION.ingestionJobId),
      provider_status: z.enum(['COMPLETE', 'FAILED', 'STOPPED', 'NONTERMINAL']),
      terminal: z.boolean(),
      terminal_statistics: terminalStatistics,
      progress_statistics: progressStatistics,
      provider_updated_at_present: z.boolean(),
      workflow_provenance_verified: z.literal(true),
      artifact_metadata_verified: z.literal(true),
      archive_digest_verification: z.enum(['verified', 'not_provided']),
      archive_sha256: z.string().regex(/^[0-9a-f]{64}$/),
      archive_bytes: z.number().int().positive().max(1024 * 1024),
      receipt_sha256: z.string().regex(/^[0-9a-f]{64}$/),
      receipt_bytes: z.number().int().positive().max(32 * 1024),
    },
    handler: async (_input, ctx) => {
      assertRepoAllowed(ctx.callerAgent, PINNED_GRAPHRAG_OBSERVATION.owner, PINNED_GRAPHRAG_OBSERVATION.repo);
      const result = await getPinnedGraphRagObservationReceipt();
      return {
        data: result,
        summary: `Pinned historical observation receipt validated (terminal=${result.terminal}; provider status=${result.provider_status}).`,
      };
    },
  }, callerHash);
}
