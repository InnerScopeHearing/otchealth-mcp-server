import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z, type ZodRawShape } from 'zod';
import { GitHubFullError, branchGet } from '../../github/full-client.js';
import { getFileContents } from '../../github/api-client.js';
import { createBranch } from '../../github/write-client.js';
import {
  executeMakeGitHubBroker,
  MAKE_GITHUB_BROKER_TOOL,
  MAKE_GITHUB_BROKER_TOOLS,
  MAKE_GITHUB_REPOSITORY,
  redactMakeGitHubBrokerInputForLog,
} from '../../github/make-broker.js';
import { registerTool, type CallerHashProvider } from '../registry.js';

const inputShape: ZodRawShape = {
  tool_name: z.enum(MAKE_GITHUB_BROKER_TOOLS)
    .describe('Pilot allowlist: github_create_branch or github_get_file_contents.'),
  arguments: z.record(z.unknown()).describe(
    'Strict operation arguments. Branch creation requires owner, repo, and a 40-character from_sha equal to verified current main. Readback requires owner, repo, path="package.json". The broker derives the pilot branch.',
  ),
  idempotency_key: z.string().regex(/^[A-Za-z0-9._:-]{16,128}$/)
    .describe('Stable 16 to 128 character request key. It derives a claude/make-pilot ref used for branch-name deduplication only while that ref exists. This is not a durable idempotency ledger.'),
};

const outputShape: ZodRawShape = {
  outcome: z.enum(['planned', 'created', 'replayed', 'read']),
  executed: z.boolean(),
  dry_run: z.boolean(),
  tool_name: z.enum(MAKE_GITHUB_BROKER_TOOLS),
  owner: z.string(),
  repo: z.string(),
  branch: z.string().optional(),
  path: z.string().optional(),
  ref: z.string().optional(),
  sha: z.string().optional(),
  from_sha: z.string().optional(),
  text: z.string().optional(),
  idempotency_key_sha256: z.string(),
  request_sha256: z.string(),
  correlation_id: z.string(),
};

export function registerGitHubMakeBroker(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: MAKE_GITHUB_BROKER_TOOL,
    category: 'write_simple',
    annotations: {
      title: 'GitHub: Make pilot broker',
      description:
        'Inactive Make pilot for InnerScopeHearing/otchealth-mcp-server only. Allows github_create_branch on a server-derived claude/make-pilot-* ref only when caller from_sha exactly matches verified current main, plus github_get_file_contents for package.json on that same key-derived ref. Existing refs replay only when their SHA matches from_sha; a different SHA is rejected. The key provides branch-name deduplication only while the ref exists, not a durable idempotency ledger, so deleting the ref removes the deduplication evidence. All nested arguments are strict. Returns correlation and receipt hashes. CTO-only; honors dry_run and gateway write gates.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    inputShape,
    outputShape,
    redactInputForLog: redactMakeGitHubBrokerInputForLog,
    handler: async (input, ctx) => {
      const repository = MAKE_GITHUB_REPOSITORY;
      const result = await executeMakeGitHubBroker(input, ctx.correlationId, {
        getBranchSha: async (branch) => {
          try {
            const response = await branchGet(repository.owner, repository.repo, branch);
            const sha = response?.commit?.sha;
            if (typeof sha !== 'string') throw new Error('GitHub branch response omitted its commit SHA.');
            return sha;
          } catch (error) {
            if (error instanceof GitHubFullError && error.status === 404) return null;
            throw error;
          }
        },
        createBranch: async (branch, fromSha) => {
          const created = await createBranch(repository.owner, repository.repo, branch, fromSha);
          return { sha: created.sha };
        },
        getFileContents: async (path, ref) => {
          const file = await getFileContents(repository.owner, repository.repo, path, ref);
          return { sha: file.sha, text: file.text };
        },
      }, ctx.dryRun);

      const auditAfter = {
        outcome: result.outcome,
        tool_name: result.tool_name,
        repository: `${result.owner}/${result.repo}`,
        ...(result.branch ? { branch: result.branch } : {}),
        ...(result.path ? { path: result.path } : {}),
        ...(result.ref ? { ref: result.ref } : {}),
        ...(result.sha ? { sha: result.sha } : {}),
        idempotency_key_sha256: result.idempotency_key_sha256,
        request_sha256: result.request_sha256,
        correlation_id: result.correlation_id,
      };
      const summary = result.tool_name === 'github_create_branch'
        ? `${result.outcome} ${result.owner}/${result.repo}:${result.branch} at ${result.sha ?? result.from_sha}.`
        : `Read ${result.owner}/${result.repo}:${result.path} at ${result.ref}.`;

      return { data: result, audit: { before: null, after: auditAfter }, summary };
    },
  }, callerHash);
}
