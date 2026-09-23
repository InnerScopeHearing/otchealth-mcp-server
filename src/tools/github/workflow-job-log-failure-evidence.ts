import { inflateRawSync } from 'node:zlib';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { workflowJobGetLogArchive, workflowRunListJobs, GitHubFullError } from '../../github/full-client.js';

export const MAX_EVIDENCE_LINES = 80;
export const FAILURE_EVIDENCE_REPOSITORY = 'InnerScopeHearing/otchealth-mcp-server';
const MAX_ARCHIVE_ENTRIES = 8;
const MAX_UNCOMPRESSED_LOG_BYTES = 2 * 1024 * 1024;
const FAILURE_CONCLUSIONS = new Set(['failure', 'cancelled', 'timed_out', 'action_required', 'startup_failure', 'stale']);

export interface FailureEvidence {
  failure_category: 'test_failure' | 'build_failure' | 'dependency_failure' | 'timeout' | 'permission_failure' | 'network_failure' | 'unknown_failure';
  total_lines: number;
  signal_count: number;
  error_count: number;
  warning_count: number;
  truncated: boolean;
}

/** This first capability is deliberately narrower than the general GitHub repo allowlist. */
export function assertFailureEvidenceRepoAllowed(owner: string, repo: string): void {
  if (`${owner}/${repo}` !== FAILURE_EVIDENCE_REPOSITORY) {
    throw new GitHubFullError({
      code: 'github_failure_evidence_repo_forbidden',
      status: 403,
      message: 'Failure evidence is unavailable for this repository.',
      nextStep: 'Use the initially supported repository for bounded failure evidence.',
    });
  }
}

export function verifyFailureJobMetadata(jobs: readonly any[], jobId: number): any {
  const job = jobs.find((candidate) => candidate?.id === jobId);
  if (!job || typeof job.id !== 'number') throw new GitHubFullError({ code: 'github_job_metadata_mismatch', status: 409, message: 'The requested job is not part of the specified workflow run.', nextStep: 'Verify the run_id and exact job_id.' });
  if (job.status !== 'completed' || !FAILURE_CONCLUSIONS.has(String(job.conclusion))) throw new GitHubFullError({ code: 'github_job_not_failed', status: 409, message: 'Failure evidence is available only for a completed failed job.', nextStep: 'Use a completed job with a failure conclusion.' });
  return job;
}

export function safeFailureEvidenceError(error: unknown, phase: 'metadata' | 'log'): GitHubFullError {
  void error;
  return new GitHubFullError({ code: phase === 'metadata' ? 'github_job_metadata_unavailable' : 'github_job_log_unavailable', status: 502, message: 'GitHub failure evidence is temporarily unavailable.', nextStep: 'Retry later or inspect the run in GitHub.' });
}

function readU16(bytes: Uint8Array, at: number): number { return bytes[at] | (bytes[at + 1] << 8); }
function readU32(bytes: Uint8Array, at: number): number { return (bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16) | (bytes[at + 3] << 24)) >>> 0; }

/** Extract the first bounded text member from GitHub's job-log ZIP response. */
export function extractJobLogText(archive: Uint8Array): string {
  let offset = 0;
  let entries = 0;
  while (offset + 30 <= archive.byteLength && entries++ < MAX_ARCHIVE_ENTRIES) {
    if (readU32(archive, offset) !== 0x04034b50) break;
    const method = readU16(archive, offset + 8);
    const compressedSize = readU32(archive, offset + 18);
    const uncompressedSize = readU32(archive, offset + 22);
    const nameLength = readU16(archive, offset + 26);
    const extraLength = readU16(archive, offset + 28);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const memberName = Buffer.from(archive.subarray(nameStart, nameStart + nameLength)).toString('utf8');
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > archive.byteLength || uncompressedSize > MAX_UNCOMPRESSED_LOG_BYTES) throw new Error('bounded log archive cannot be safely inspected');
    const compressed = archive.subarray(dataStart, dataEnd);
    if (entries === 1 || /\.(?:txt|log)$/i.test(memberName)) {
      let plain: Uint8Array;
      if (method === 0) plain = compressed;
      else if (method === 8) plain = inflateRawSync(compressed, { maxOutputLength: MAX_UNCOMPRESSED_LOG_BYTES });
      else throw new Error('unsupported log archive compression');
      if (plain.byteLength > MAX_UNCOMPRESSED_LOG_BYTES) throw new Error('bounded log archive cannot be safely inspected');
      return Buffer.from(plain).toString('utf8');
    }
    offset = dataEnd;
  }
  throw new Error('GitHub job log archive did not contain a bounded text member');
}

export function summarizeFailureEvidence(text: string, startLine = 1, maxLines = MAX_EVIDENCE_LINES): FailureEvidence {
  const all = text.split(/\r?\n/);
  const start = Math.max(1, Math.min(startLine, all.length + 1));
  const limit = Math.max(1, Math.min(maxLines, MAX_EVIDENCE_LINES));
  const selected = all.slice(start - 1, start - 1 + limit);
  const joined = selected.join('\n');
  const matches = (re: RegExp): number => joined.match(re)?.length ?? 0;
  const failure_category = /(?:timeout|timed out|deadline exceeded)/i.test(joined) ? 'timeout'
    : /(?:permission denied|forbidden|unauthorized|access denied)/i.test(joined) ? 'permission_failure'
    : /(?:network|connection refused|connection reset|dns|econn)/i.test(joined) ? 'network_failure'
    : /(?:npm|pnpm|yarn|pip|cargo|dependency|package .*not found)/i.test(joined) ? 'dependency_failure'
    : /(?:test failed|tests?\s+failed|assertion|expect\()/i.test(joined) ? 'test_failure'
    : /(?:build failed|compilation failed|compile error|ts\d{4}|error:)/i.test(joined) ? 'build_failure'
    : 'unknown_failure';
  return { failure_category, total_lines: all.length, signal_count: matches(/(?:error|fail|failed|failure|exception|timeout|denied|forbidden)/gi), error_count: matches(/(?:error|exception|failed|failure)/gi), warning_count: matches(/warning/gi), truncated: start - 1 + selected.length < all.length };
}

export function registerGitHubWorkflowJobLogFailureEvidence(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'github_workflow_job_log_failure_evidence',
    category: 'read',
    annotations: {
      title: 'GitHub: bounded workflow job failure evidence',
      description: 'Classify one verified failed Actions job log into a fixed failure category with bounded numeric counters. CTO-only and read-only; no log text, archive metadata, URLs, paths, or credentials are returned.',
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      owner: z.string().describe('Repository owner.'),
      repo: z.string().describe('Repository name.'),
      run_id: z.number().int().positive().describe('Workflow run numeric ID.'),
      job_id: z.number().int().positive().describe('Exact job numeric ID, verified against the run.'),
      start_line: z.number().int().positive().max(2_000_000).optional().describe('One-based first line of the bounded internal classification window.'),
      max_lines: z.number().int().positive().max(MAX_EVIDENCE_LINES).optional().describe('Maximum lines in the bounded internal classification window.'),
    },
    outputShape: {
      job_id: z.number(),
      evidence: z.object({ failure_category: z.enum(['test_failure', 'build_failure', 'dependency_failure', 'timeout', 'permission_failure', 'network_failure', 'unknown_failure']), total_lines: z.number(), signal_count: z.number(), error_count: z.number(), warning_count: z.number(), truncated: z.boolean() }),
    },
    handler: async (input, _ctx) => {
      // This exact allowlist runs before any GitHub request, including metadata verification, and
      // intentionally rejects PHI/MedReview and every other repository even for CTO callers.
      assertFailureEvidenceRepoAllowed(input.owner, input.repo);
      let jobs: any[];
      try { jobs = await workflowRunListJobs(input.owner, input.repo, input.run_id, 'all'); }
      catch (error) { throw safeFailureEvidenceError(error, 'metadata'); }
      const job = verifyFailureJobMetadata(jobs, input.job_id);
      let archive: Uint8Array;
      try { archive = await workflowJobGetLogArchive(input.owner, input.repo, input.job_id); }
      catch (error) { throw safeFailureEvidenceError(error, 'log'); }
      let extracted: string;
      try { extracted = extractJobLogText(archive); }
      catch { throw new GitHubFullError({ code: 'github_job_log_unreadable', status: 422, message: 'GitHub failure evidence is unavailable for this log.', nextStep: 'Inspect the job log in GitHub.' }); }
      const evidence = summarizeFailureEvidence(extracted, input.start_line ?? 1, input.max_lines ?? MAX_EVIDENCE_LINES);
      return { data: { job_id: job.id, evidence }, summary: 'Bounded classification-only failure evidence returned.' };
    },
  }, callerHash);
}
