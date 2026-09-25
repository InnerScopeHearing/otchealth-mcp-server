import { createHash } from 'node:crypto';
import { z } from 'zod';

export const MAKE_GITHUB_BROKER_TOOL = 'github_make_broker' as const;
export const MAKE_GITHUB_BROKER_TOOLS = ['github_create_branch', 'github_get_file_contents', 'github_get_main_sha'] as const;
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

const LOGGABLE_ARGUMENT_FIELDS: Record<string, readonly string[]> = {
  github_create_branch: ['owner', 'repo', 'from_sha'],
  github_get_file_contents: ['owner', 'repo', 'path'],
  github_get_main_sha: [],
};

/**
 * Project the untrusted envelope into safe audit metadata before the handler validates it.
 * Never copy argument values or unexpected fields into the log projection.
 */
export function redactMakeGitHubBrokerInputForLog(input: Record<string, unknown>): Record<string, unknown> {
  const requestedToolName = input.tool_name;
  const toolName = typeof requestedToolName === 'string' &&
    (MAKE_GITHUB_BROKER_TOOLS as readonly string[]).includes(requestedToolName)
    ? requestedToolName
    : 'unlisted';
  const rawArguments = input.arguments;
  const args = rawArguments !== null && typeof rawArguments === 'object' && !Array.isArray(rawArguments)
    ? rawArguments as Record<string, unknown>
    : {};
  const argumentFields = (LOGGABLE_ARGUMENT_FIELDS[toolName] ?? [])
    .filter((field) => Object.prototype.hasOwnProperty.call(args, field));
  const idempotencyKey = input.idempotency_key;

  return {
    tool_name: toolName,
    argument_fields: argumentFields,
    ...(typeof idempotencyKey === 'string' && IDEMPOTENCY_KEY_RE.test(idempotencyKey)
      ? { idempotency_key_sha256: sha256(idempotencyKey) }
      : {}),
  };
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
  from_sha: z.string().regex(COMMIT_SHA_RE),
}).strict();

const getFileContentsArgumentsSchema = z.object({
  owner: z.literal(MAKE_GITHUB_REPOSITORY.owner),
  repo: z.literal(MAKE_GITHUB_REPOSITORY.repo),
  path: z.literal(PILOT_READ_PATH),
}).strict();

const getMainShaArgumentsSchema = z.object({}).strict();

type CreateBranchArguments = z.infer<typeof createBranchArgumentsSchema>;
type GetFileContentsArguments = z.infer<typeof getFileContentsArgumentsSchema>;
type GetMainShaArguments = z.infer<typeof getMainShaArgumentsSchema>;

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
    }
  | {
      toolName: 'github_get_main_sha';
      args: GetMainShaArguments;
      ref: 'main';
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
 * Parse the dynamic Make envelope into one of three exact GitHub requests. This function is the
 * broker's authorization boundary: nested argument objects are strict, the resource is fixed,
 * and branch/ref names are derived here rather than accepted from the caller.
 */
export function parseMakeGitHubBrokerCall(value: unknown): ParsedBrokerCall {
  const envelope = parseWithSchema(envelopeSchema, value, 'invalid_broker_input', 'Make GitHub broker envelope');
  const allowed = (MAKE_GITHUB_BROKER_TOOLS as readonly string[]).includes(envelope.tool_name);
  if (!allowed) {
    throw new MakeGitHubBrokerPolicyError('tool_not_allowed', 'The requested GitHub tool is not in the Make pilot allowlist.');
  }

  const idempotencyKeySha256 = sha256(envelope.idempotency_key);

  if (envelope.tool_name === 'github_get_main_sha') {
    const args = parseWithSchema(
      getMainShaArgumentsSchema,
      envelope.arguments,
      'invalid_github_arguments',
      'github_get_main_sha arguments',
    );
    return {
      toolName: 'github_get_main_sha',
      args,
      ref: 'main',
      idempotencyKeySha256,
      requestSha256: stableSha256(['github_get_main_sha', MAKE_GITHUB_REPOSITORY.owner, MAKE_GITHUB_REPOSITORY.repo, 'main']),
    };
  }

  const expectedBranch = makeGitHubBrokerBranch(envelope.idempotency_key);

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
        'github_create_branch', args.owner, args.repo, expectedBranch, args.from_sha,
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

  if (dryRun) {
    return {
      ...base,
      outcome: 'planned',
      executed: false,
      dry_run: true,
      ...(call.toolName === 'github_create_branch'
        ? { branch: call.branch, from_sha: call.args.from_sha }
        : call.toolName === 'github_get_file_contents'
          ? { path: call.args.path, ref: call.ref }
          : { ref: call.ref }),
    };
  }

  if (call.toolName === 'github_get_main_sha') {
    const sha = await dependencies.getBranchSha(call.ref);
    if (sha === null) {
      throw new MakeGitHubBrokerPolicyError('main_ref_missing', 'The target repository main branch could not be verified.');
    }
    if (!COMMIT_SHA_RE.test(sha)) {
      throw new MakeGitHubBrokerPolicyError('main_ref_invalid', 'The target repository main branch returned an invalid commit SHA.');
    }
    return {
      ...base,
      outcome: 'read',
      executed: true,
      dry_run: false,
      ref: call.ref,
      sha,
    };
  }

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

  const existingSha = await dependencies.getBranchSha(call.branch);
  if (existingSha !== null) {
    if (existingSha !== call.args.from_sha) {
      throw new MakeGitHubBrokerPolicyError(
        'idempotency_conflict',
        'The key-derived branch already exists at a different commit and cannot be replayed.',
      );
    }
    return {
      ...base,
      outcome: 'replayed',
      executed: true,
      dry_run: false,
      branch: call.branch,
      sha: existingSha,
      from_sha: call.args.from_sha,
    };
  }

  const mainSha = await dependencies.getBranchSha('main');
  if (mainSha === null) {
    throw new MakeGitHubBrokerPolicyError('main_ref_missing', 'The target repository main branch could not be verified.');
  }
  if (!COMMIT_SHA_RE.test(mainSha)) {
    throw new MakeGitHubBrokerPolicyError('main_ref_invalid', 'The target repository main branch returned an invalid commit SHA.');
  }
  if (mainSha !== call.args.from_sha) {
    throw new MakeGitHubBrokerPolicyError(
      'main_ref_mismatch',
      'The requested source commit does not match the verified current main branch.',
    );
  }

  let created: { sha: string };
  try {
    created = await dependencies.createBranch(call.branch, call.args.from_sha);
  } catch (createError) {
    // Reconcile a duplicate-create race or an unknown write acknowledgement by exact readback.
    let observedSha: string | null;
    try {
      observedSha = await dependencies.getBranchSha(call.branch);
    } catch {
      throw createError;
    }
    if (observedSha !== null) {
      if (observedSha !== call.args.from_sha) {
        throw new MakeGitHubBrokerPolicyError(
          'idempotency_conflict',
          'The key-derived branch exists at a different commit after an uncertain create.',
        );
      }
      return {
        ...base,
        outcome: 'replayed',
        executed: true,
        dry_run: false,
        branch: call.branch,
        sha: observedSha,
        from_sha: call.args.from_sha,
      };
    }
    throw createError;
  }

  if (created.sha !== call.args.from_sha) {
    throw new MakeGitHubBrokerPolicyError('create_result_mismatch', 'GitHub returned an unexpected branch commit.');
  }

  // Do not trust the create response as the terminal receipt. Independently read the exact
  // server-derived ref and bind the returned SHA to the validated request source.
  const readbackSha = await dependencies.getBranchSha(call.branch);
  if (readbackSha === null) {
    throw new MakeGitHubBrokerPolicyError('branch_readback_missing', 'The created branch was not visible on independent readback.');
  }
  if (readbackSha !== created.sha || readbackSha !== call.args.from_sha) {
    throw new MakeGitHubBrokerPolicyError('branch_readback_mismatch', 'Independent branch readback did not match the requested source commit.');
  }

  return {
    ...base,
    outcome: 'created',
    executed: true,
    dry_run: false,
    branch: call.branch,
    sha: readbackSha,
    from_sha: call.args.from_sha,
  };
}
