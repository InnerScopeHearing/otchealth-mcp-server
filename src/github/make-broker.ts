import { createHash } from 'node:crypto';
import { z } from 'zod';

export const MAKE_GITHUB_BROKER_TOOL = 'github_make_broker' as const;
export const MAKE_GITHUB_BROKER_TOOLS = ['github_create_branch', 'github_get_file_contents'] as const;
export const MAKE_GITHUB_REPOSITORY = {
  owner: 'InnerScopeHearing',
  repo: 'otchealth-mcp-server',
} as const;

const PILOT_BRANCH_PREFIX = 'claude/make-pilot-';
const COMMIT_SHA_RE = /^[a-f0-9]{40}$/;
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9._:-]{16,128}$/;
const PILOT_READ_PATH = 'package.json';

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

export function makeGitHubBrokerBranch(idempotencyKey: string): string {
  if (!IDEMPOTENCY_KEY_RE.test(idempotencyKey)) {
    throw new MakeGitHubBrokerPolicyError('invalid_idempotency_key', 'Use a 16 to 128 character idempotency key.');
  }
  return `${PILOT_BRANCH_PREFIX}${sha256(idempotencyKey).slice(0, 32)}`;
}

export function makeGitHubBrokerKeyHash(idempotencyKey: string): string {
  return sha256(idempotencyKey);
}

export class MakeGitHubBrokerPolicyError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'MakeGitHubBrokerPolicyError';
  }
}

const envelopeSchema = z.object({
  tool_name: z.string().min(1).max(80),
  arguments: z.record(z.unknown()),
  idempotency_key: z.string().regex(IDEMPOTENCY_KEY_RE),
}).strict();

const createBranchArgumentsSchema = z.object({
  owner: z.literal(MAKE_GITHUB_REPOSITORY.owner),
  repo: z.literal(MAKE_GITHUB_REPOSITORY.repo),
}).strict();

const getFileContentsArgumentsSchema = z.object({
  owner: z.literal(MAKE_GITHUB_REPOSITORY.owner),
  repo: z.literal(MAKE_GITHUB_REPOSITORY.repo),
  path: z.literal(PILOT_READ_PATH),
}).strict();

type CreateBranchArguments = z.infer<typeof createBranchArgumentsSchema>;
type GetFileContentsArguments = z.infer<typeof getFileContentsArgumentsSchema>;

type ParsedBrokerCall =
  | {
      toolName: 'github_create_branch';
      args: CreateBranchArguments;
      branch: string;
      idempotencyKeySha256: string;
      requestSha256: string;
    }
  | {
      toolName: 'github_get_file_contents';
      args: GetFileContentsArguments;
      ref: string;
      idempotencyKeySha256: string;
      requestSha256: string;
    };

function parseWithSchema<T>(schema: z.ZodType<T>, value: unknown, code: string, label: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((issue) => issue.path.join('.') || '(root)').join(', ');
    throw new MakeGitHubBrokerPolicyError(code, `${label} failed validation at: ${fields}.`);
  }
  return parsed.data;
}

function stableSha256(value: unknown): string {
  return sha256(JSON.stringify(value));
}

/**
 * Parse the dynamic Make envelope into one of two exact GitHub requests. This function is the
 * broker's authorization boundary: nested argument objects are strict, the resource is fixed,
 * and branch/ref names are derived here rather than accepted from the caller.
 */
export function parseMakeGitHubBrokerCall(value: unknown): ParsedBrokerCall {
  const envelope = parseWithSchema(envelopeSchema, value, 'invalid_broker_input', 'Make GitHub broker envelope');
  const allowed = (MAKE_GITHUB_BROKER_TOOLS as readonly string[]).includes(envelope.tool_name);
  if (!allowed) {
    throw new MakeGitHubBrokerPolicyError('tool_not_allowed', 'The requested GitHub tool is not in the Make pilot allowlist.');
  }

  const expectedBranch = makeGitHubBrokerBranch(envelope.idempotency_key);
  const idempotencyKeySha256 = sha256(envelope.idempotency_key);

  if (envelope.tool_name === 'github_create_branch') {
    const args = parseWithSchema(
      createBranchArgumentsSchema,
      envelope.arguments,
      'invalid_github_arguments',
      'github_create_branch arguments',
    );
    return {
      toolName: 'github_create_branch',
      args,
      branch: expectedBranch,
      idempotencyKeySha256,
      requestSha256: stableSha256([
        'github_create_branch', args.owner, args.repo, expectedBranch,
      ]),
    };
  }

  const args = parseWithSchema(
    getFileContentsArgumentsSchema,
    envelope.arguments,
    'invalid_github_arguments',
    'github_get_file_contents arguments',
  );
  return {
    toolName: 'github_get_file_contents',
    args,
    ref: expectedBranch,
    idempotencyKeySha256,
    requestSha256: stableSha256([
      'github_get_file_contents', args.owner, args.repo, args.path, expectedBranch,
    ]),
  };
}

export interface MakeGitHubBrokerDependencies {
  /** Return the commit SHA at a branch, or null when that branch does not exist. */
  getBranchSha(branch: string): Promise<string | null>;
  createBranch(branch: string, fromSha: string): Promise<{ sha: string }>;
  getFileContents(path: string, ref: string): Promise<{ sha: string; text: string }>;
}

export interface MakeGitHubBrokerReceipt {
  outcome: 'planned' | 'created' | 'replayed' | 'read';
  executed: boolean;
  dry_run: boolean;
  tool_name: ParsedBrokerCall['toolName'];
  owner: string;
  repo: string;
  branch?: string;
  path?: string;
  ref?: string;
  sha?: string;
  from_sha?: string;
  text?: string;
  idempotency_key_sha256: string;
  request_sha256: string;
  correlation_id: string;
}

function baseReceipt(call: ParsedBrokerCall, correlationId: string) {
  return {
    tool_name: call.toolName,
    owner: MAKE_GITHUB_REPOSITORY.owner,
    repo: MAKE_GITHUB_REPOSITORY.repo,
    idempotency_key_sha256: call.idempotencyKeySha256,
    request_sha256: call.requestSha256,
    correlation_id: correlationId,
  };
}

/** Execute a validated pilot request. All policy checks finish before createBranch is reachable. */
export async function executeMakeGitHubBroker(
  value: unknown,
  correlationId: string,
  dependencies: MakeGitHubBrokerDependencies,
  dryRun: boolean,
): Promise<MakeGitHubBrokerReceipt> {
  const call = parseMakeGitHubBrokerCall(value);
  const base = baseReceipt(call, correlationId);

  if (call.toolName === 'github_get_file_contents') {
    const file = await dependencies.getFileContents(call.args.path, call.ref);
    return {
      ...base,
      outcome: 'read',
      executed: true,
      dry_run: false,
      path: call.args.path,
      ref: call.ref,
      sha: file.sha,
      text: file.text,
    };
  }

  if (dryRun) {
    return {
      ...base,
      outcome: 'planned',
      executed: false,
      dry_run: true,
      branch: call.branch,
    };
  }

  const existingSha = await dependencies.getBranchSha(call.branch);
  if (existingSha !== null) {
    return {
      ...base,
      outcome: 'replayed',
      executed: true,
      dry_run: false,
      branch: call.branch,
      sha: existingSha,
    };
  }

  const mainSha = await dependencies.getBranchSha('main');
  if (mainSha === null) {
    throw new MakeGitHubBrokerPolicyError('main_ref_missing', 'The target repository main branch could not be verified.');
  }
  if (!COMMIT_SHA_RE.test(mainSha)) {
    throw new MakeGitHubBrokerPolicyError('main_ref_invalid', 'The target repository main branch returned an invalid commit SHA.');
  }

  try {
    const created = await dependencies.createBranch(call.branch, mainSha);
    if (created.sha !== mainSha) {
      throw new MakeGitHubBrokerPolicyError('create_result_mismatch', 'GitHub returned an unexpected branch commit.');
    }
    return {
      ...base,
      outcome: 'created',
      executed: true,
      dry_run: false,
      branch: call.branch,
      sha: created.sha,
      from_sha: mainSha,
    };
  } catch (createError) {
    // Reconcile a duplicate-create race or an unknown write acknowledgement by exact readback.
    let observedSha: string | null;
    try {
      observedSha = await dependencies.getBranchSha(call.branch);
    } catch {
      throw createError;
    }
    if (observedSha !== null) {
      return {
        ...base,
        outcome: 'replayed',
        executed: true,
        dry_run: false,
        branch: call.branch,
        sha: observedSha,
      };
    }
    throw createError;
  }
}
