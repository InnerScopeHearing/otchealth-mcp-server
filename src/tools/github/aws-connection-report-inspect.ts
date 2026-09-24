import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { AWS_CONNECTION_REPORT_ARTIFACT, MAX_AWS_CONNECTION_REPORT_ARCHIVE_BYTES } from '../../github/aws-connection-report-artifact.js';
import { inspectAwsConnectionReportArtifact } from '../../github/full-client.js';
import { assertRepoAllowed } from '../../github/api-client.js';
import { registerTool, type CallerHashProvider } from '../registry.js';

const RESULT_SCHEMA = 'otchealth-github-aws-connection-report-inspection-v1';

export function registerGitHubAwsConnectionReportInspect(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'github_aws_connection_report_inspect',
    category: 'read',
    annotations: {
      title: 'GitHub: inspect AWS connection report safely',
      description: 'Inspect one AWS connection report artifact from the approved producer workflow in the fixed CTO repository. The bounded archive is inspected in memory and the result contains provenance, an explicit trusted-digest status, aggregate-only, and redaction pass or fail fields only. Report contents and signed URLs are never returned. CTO only.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      owner: z.literal(AWS_CONNECTION_REPORT_ARTIFACT.owner).describe('Fixed report repository owner.'),
      repo: z.literal(AWS_CONNECTION_REPORT_ARTIFACT.repo).describe('Fixed report repository.'),
      run_id: z.number().int().positive().describe('Workflow run ID that uploaded the report artifact.'),
      artifact_id: z.number().int().positive().describe('Artifact ID returned for that workflow run.'),
      expected_sha256: z.string().regex(/^(?:sha256:)?[a-f0-9]{64}$/i).describe('GitHub archive digest returned by the artifact listing, passed unchanged for cross-checking.'),
    },
    outputShape: {
      schema: z.literal(RESULT_SCHEMA),
      run_id: z.number().int().positive(),
      artifact_id: z.number().int().positive(),
      repository_binding_verified: z.literal(true),
      workflow_run_binding_verified: z.literal(true),
      artifact_binding_verified: z.literal(true),
      archive_digest_verified: z.literal(true),
      archive_digest_status: z.literal('github_artifact_digest_verified'),
      caller_expected_digest_match: z.literal(true),
      archive_bytes: z.number().int().positive().max(MAX_AWS_CONNECTION_REPORT_ARCHIVE_BYTES),
      aggregate_only: z.boolean(),
      redaction_pass: z.boolean(),
    },
    handler: async (input, ctx) => {
      if (ctx.callerAgent !== 'cto') throw new Error('CTO identity required');
      assertRepoAllowed(ctx.callerAgent, input.owner, input.repo);
      const result = await inspectAwsConnectionReportArtifact(
        input.owner,
        input.repo,
        input.run_id,
        input.artifact_id,
        input.expected_sha256,
      );
      return {
        data: result,
        summary: `AWS report producer provenance verified; archive-digest-status=${result.archive_digest_status}; aggregate-only=${result.aggregate_only}; redaction-pass=${result.redaction_pass}.`,
      };
    },
  }, callerHash);
}
