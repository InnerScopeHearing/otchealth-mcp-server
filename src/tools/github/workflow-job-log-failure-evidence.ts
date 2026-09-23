import { inflateRawSync } from 'node:zlib';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { assertRepoAllowed } from '../../github/api-client.js';
import { workflowJobGetLogArchive, workflowRunListJobs, GitHubFullError } from '../../github/full-client.js';

export const MAX_EVIDENCE_LINES = 80;
export const MAX_EVIDENCE_LINE_BYTES = 4_000;
const MAX_ARCHIVE_ENTRIES = 8;
const MAX_UNCOMPRESSED_LOG_BYTES = 2 * 1024 * 1024;
const FAILURE_CONCLUSIONS = new Set(['failure', 'cancelled', 'timed_out', 'action_required', 'startup_failure', 'stale']);

export interface FailureEvidence {
  lines: string[];
  total_lines: number;
  redacted_count: number;
  truncated: boolean;
  source_file: string;
}

/** Remove URLs, authorization/header values, and common secret-shaped values before any output. */
export function sanitizeLogLine(value: string): { line: string; redactions: number } {
  let line = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ');
  let redactions = 0;
  const replace = (re: RegExp, replacement: string) => { line = line.replace(re, (...args) => { redactions++; return replacement.replace('$1', String(args[1] ?? '')); }); };
  replace(/https?:\/\/[^\s\])}>]+/gi, '[redacted-url]');
  replace(/((?:authorization|proxy-authorization)\s*[:=]\s*(?:bearer|basic)\s+)[^\s,;]+/gi, '$1[redacted]');
  replace(/((?:cookie|set-cookie|x-api-key|api-key|private-key)\s*[:=]\s*)[^\s,;]+/gi, '$1[redacted]');
  replace(/((?:password|passwd|secret|token|api[_-]?key|client[_-]?secret)\s*[:=]\s*)[^\s,;]+/gi, '$1[redacted]');
  replace(/\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]+)\b/g, '[redacted-secret]');
  replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[redacted-jwt]');
  replace(/[?&](?:token|sig|signature|expires|X-Amz-[A-Za-z-]+)=[^&\s]+/gi, '?[redacted-query]');
  if (Buffer.byteLength(line, 'utf8') > MAX_EVIDENCE_LINE_BYTES) {
    line = Buffer.from(line, 'utf8').subarray(0, MAX_EVIDENCE_LINE_BYTES).toString('utf8') + '…';
    redactions++;
  }
  return { line, redactions };
}

function readU16(bytes: Uint8Array, at: number): number { return bytes[at] | (bytes[at + 1] << 8); }
function readU32(bytes: Uint8Array, at: number): number { return (bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16) | (bytes[at + 3] << 24)) >>> 0; }

/** Extract the first bounded text member from GitHub's job-log ZIP response. */
export function extractJobLogText(archive: Uint8Array): { text: string; source_file: string } {
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
    const name = Buffer.from(archive.subarray(nameStart, nameStart + nameLength)).toString('utf8');
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > archive.byteLength || uncompressedSize > MAX_UNCOMPRESSED_LOG_BYTES) throw new Error('bounded log archive cannot be safely inspected');
    const compressed = archive.subarray(dataStart, dataEnd);
    if (/\.(?:txt|log)$/i.test(name) || entries === 1) {
      let plain: Uint8Array;
      if (method === 0) plain = compressed;
      else if (method === 8) plain = inflateRawSync(compressed, { maxOutputLength: MAX_UNCOMPRESSED_LOG_BYTES });
      else throw new Error('unsupported log archive compression');
      if (plain.byteLength > MAX_UNCOMPRESSED_LOG_BYTES) throw new Error('bounded log archive cannot be safely inspected');
      return { text: Buffer.from(plain).toString('utf8'), source_file: name.slice(0, 256) };
    }
    offset = dataEnd;
  }
  throw new Error('GitHub job log archive did not contain a bounded text member');
}

export function summarizeFailureEvidence(text: string, startLine = 1, maxLines = MAX_EVIDENCE_LINES): FailureEvidence {
  const all = text.split(/\r?\n/);
  const start = Math.max(1, Math.min(startLine, all.length + 1));
  const limit = Math.max(1, Math.min(maxLines, MAX_EVIDENCE_LINES));
  let redacted_count = 0;
  const lines: string[] = [];
  for (let i = start - 1; i < all.length && lines.length < limit; i++) {
    const safe = sanitizeLogLine(all[i]);
    redacted_count += safe.redactions;
    lines.push(safe.line);
  }
  return { lines, total_lines: all.length, redacted_count, truncated: start - 1 + lines.length < all.length, source_file: '' };
}

export function registerGitHubWorkflowJobLogFailureEvidence(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'github_workflow_job_log_failure_evidence',
    category: 'read',
    annotations: {
      title: 'GitHub: bounded workflow job failure evidence',
      description: 'Retrieve a bounded, sanitized summary from one verified failed Actions job log. CTO-only and read-only; raw logs, archives, URLs, and credentials are never returned.',
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      owner: z.string().describe('Repository owner.'),
      repo: z.string().describe('Repository name.'),
      run_id: z.number().int().positive().describe('Workflow run numeric ID.'),
      job_id: z.number().int().positive().describe('Exact job numeric ID, verified against the run.'),
      start_line: z.number().int().positive().max(2_000_000).optional().describe('One-based first line to include.'),
      max_lines: z.number().int().positive().max(MAX_EVIDENCE_LINES).optional().describe('Maximum sanitized lines to return.'),
    },
    outputShape: {
      job: z.object({ id: z.number(), name: z.string().nullable(), conclusion: z.string().nullable(), status: z.string().nullable() }),
      evidence: z.object({ lines: z.array(z.string()), total_lines: z.number(), redacted_count: z.number(), truncated: z.boolean(), source_file: z.string() }),
    },
    handler: async (input, ctx) => {
      assertRepoAllowed(ctx.callerAgent, input.owner, input.repo);
      let jobs: any[];
      try { jobs = await workflowRunListJobs(input.owner, input.repo, input.run_id, 'all'); }
      catch (error) {
        if (error instanceof GitHubFullError) throw new GitHubFullError({ code: error.code, status: error.status, message: 'GitHub job metadata verification failed.', nextStep: 'Verify the GitHub App can read this repository and workflow run.' });
        throw new Error('GitHub job metadata verification failed.');
      }
      const job = jobs.find((candidate) => candidate?.id === input.job_id);
      if (!job || typeof job.id !== 'number') throw new GitHubFullError({ code: 'github_job_metadata_mismatch', status: 409, message: 'The requested job is not part of the specified workflow run.', nextStep: 'Verify the run_id and exact job_id.' });
      if (job.status !== 'completed' || !FAILURE_CONCLUSIONS.has(String(job.conclusion))) throw new GitHubFullError({ code: 'github_job_not_failed', status: 409, message: 'Failure evidence is available only for a completed failed job.', nextStep: 'Use a completed job with a failure conclusion.' });
      let archive: Uint8Array;
      try { archive = await workflowJobGetLogArchive(input.owner, input.repo, input.job_id); }
      catch (error) {
        if (error instanceof GitHubFullError) throw new GitHubFullError({ code: error.code, status: error.status, message: 'GitHub job log retrieval failed.', nextStep: 'Verify the GitHub App can read Actions job logs for this repository.' });
        throw new Error('GitHub job log retrieval failed.');
      }
      const extracted = extractJobLogText(archive);
      const evidence = summarizeFailureEvidence(extracted.text, input.start_line ?? 1, input.max_lines ?? MAX_EVIDENCE_LINES);
      evidence.source_file = sanitizeLogLine(extracted.source_file).line;
      const safeJobName = typeof job.name === 'string' ? sanitizeLogLine(job.name.slice(0, 256)).line : null;
      return { data: { job: { id: job.id, name: safeJobName, conclusion: job.conclusion ?? null, status: job.status ?? null }, evidence }, summary: `Bounded sanitized failure evidence for job #${job.id}.` };
    },
  }, callerHash);
}
