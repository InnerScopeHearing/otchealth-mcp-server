/**
 * TOMBSTONES for the Azure control-plane tool family.
 *
 * WHAT HAPPENED. Azure subscription 55c84f6b-ef90-4259-a58b-50835cc4cab4 is permanently gone, and
 * the gateway itself no longer runs on Azure: it runs as ECS service `otchealth-gateway` on cluster
 * `otchealth` in us-east-1. Every `azure_*` tool in src/tools/azure/ reaches Azure through exactly
 * one of two doors, and BOTH are shut in that runtime:
 *
 *   1. arm-client.ts's miToken(), which needs IDENTITY_ENDPOINT + IDENTITY_HEADER. Those are
 *      injected ONLY into an Azure Container Apps replica. They are absent from the live ECS task
 *      definition (infra/aws/data/task-definition-gateway-container.json: 82 environment entries,
 *      65 secrets, neither name present), so miToken() throws before any Azure request is made.
 *      This door backs ARM (jobs, container apps, resources), Log Analytics, and BOTH search-key
 *      helpers (searchQueryKey / searchAdminKey).
 *   2. searchAdminKey()'s AZURE_SEARCH_ADMIN_KEY direct-key escape hatch, used only by the two
 *      Azure AI Search WRITE tools. Also absent from that task definition.
 *
 * WHY THIS FILE EXISTS RATHER THAN A DELETION. Left alone, the failure is the fleet's recurring
 * defect class wearing a new face. An agent reaching for `azure_containerapp_set_env` -- the
 * obvious-looking tool for "fix the gateway's environment" -- gets
 *
 *     Tool azure_containerapp_set_env failed: managed identity unavailable
 *     (IDENTITY_ENDPOINT/IDENTITY_HEADER unset). ...
 *     Next step: Check server logs for the correlation_id.
 *
 * which reads exactly like a transient auth/config problem worth retrying, and points nowhere. Worse,
 * the write tools default to dry_run=true and several of those dry-run branches return a confident
 * "DRY RUN: would set ..." plan WITHOUT touching Azure at all -- a plausible-looking success for a
 * resource that no longer exists. Deregistering the tools instead would replace that with a bare
 * "Tool not found" for a name many agents have memorised, which is a dead end carrying no pointer.
 *
 * So the tools stay registered and fail IMMEDIATELY -- before input handling, before the dry-run
 * branch, before any network or auth attempt -- with a named error code, a per-tool replacement, and
 * an explicit statement that retrying will not help. This mirrors the disarm-not-delete convention
 * already applied to the three Azure-only workflows in .github/workflows (commit e968cb2).
 *
 * WHY A CONDITION AND NOT A HARDCODED `throw`. The guard asks the runtime what it can actually do,
 * so it can never rot into a lie in either direction: if Azure genuinely returns under a different
 * subscription, or an operator sets AZURE_SEARCH_ADMIN_KEY to manage a surviving index during a
 * rollback, the affected tool works again with no code change. Today, in production, every condition
 * is false and every tool below is a tombstone.
 */

import { azureConfig, searchAdminKeyConfigured } from './arm-client.js';

/** The subscription every ARM path in arm-client.ts targets by default, and which no longer exists. */
export const DELETED_SUBSCRIPTION_ID = '55c84f6b-ef90-4259-a58b-50835cc4cab4';

/** Where the operations that replaced this family actually live. */
export const RECOVERY_CONSOLE =
  'InnerScopeHearing/otchealth-cto .github/workflows/aws-recovery-console.yml';

/**
 * Thrown by the guards below. `name`/`code`/`nextStep` are the shape registry.ts's
 * parseUpstreamToolError() recognises, so the caller receives a real machine-readable error code and
 * a real next step instead of the generic `tool_error` + "Check server logs for the correlation_id."
 */
export class RetiredAzureToolError extends Error {
  readonly name = 'RetiredAzureToolError';
  readonly code = 'azure_control_plane_retired';
  readonly nextStep: string;
  constructor(message: string, nextStep: string) {
    super(message);
    this.nextStep = nextStep;
  }
}

/** Which credential door a given tool depends on. */
export type AzureDoor =
  /** arm-client.ts miToken() -> ARM / Log Analytics / listQueryKeys. Managed identity only. */
  | 'arm'
  /** searchResourcePut() -> searchAdminKey(): AZURE_SEARCH_ADMIN_KEY, else miToken() via ARM. */
  | 'arm-or-search-admin-key';

export interface RetiredAzureTool {
  door: AzureDoor;
  /** What to do instead. Named operation or named file -- never "ask someone". */
  replacement: string;
}

const OPENSEARCH_NOTE =
  'The brain runs on OpenSearch (the live task definition sets SEARCH_BACKEND=opensearch), so an ' +
  'Azure AI Search index is no longer the thing agents read';

/**
 * EVERY azure_* tool registered in src/tools/azure/, with its door and its replacement.
 *
 * ANTI-ROT: src/tools/azure/retired.test.ts enumerates the tools the real registration path actually
 * registers and fails if any azure_* tool is missing from this table, or if a table entry names a
 * tool that no longer exists. A new azure_* tool cannot be added without a deliberate decision here.
 */
export const RETIRED_AZURE_TOOLS: Readonly<Record<string, RetiredAzureTool>> = Object.freeze({
  azure_containerapp_get: {
    door: 'arm',
    replacement:
      `Use the \`report-only\` operation of ${RECOVERY_CONSOLE}: it prints the live ECS task ` +
      'definition for service otchealth-gateway, including image and the provider selectors ' +
      '(LLM_PROVIDER / EMBEDDINGS_PROVIDER / SEARCH_BACKEND / BLOB_BACKEND / STATE_BACKEND).',
  },
  azure_containerapp_set_env: {
    door: 'arm',
    replacement:
      `Use ${RECOVERY_CONSOLE}. Its \`set-llm-provider\` operation IS the task-definition env edit: ` +
      'it clones the live definition, changes only the named variable, diffs before against after, ' +
      'and needs apply=true to mutate. For a different variable, add an operation there following ' +
      'that same clone-change-one-field-and-diff shape.',
  },
  azure_job_execute: {
    door: 'arm',
    replacement:
      `Use the \`smoke-test-job\` operation of ${RECOVERY_CONSOLE} (apply=true): it runs one ECS ` +
      "task definition once, then reads THAT task's own CloudWatch log stream and surfaces the real " +
      'container exit code.',
  },
  azure_job_executions: {
    door: 'arm',
    replacement:
      `Use ${RECOVERY_CONSOLE}: \`report-only\` lists every EventBridge schedule with its state plus ` +
      'recent ECS task runs, and `smoke-test-job` prints one run\'s exit code and log.',
  },
  azure_job_get: {
    door: 'arm',
    replacement:
      'ECS task definitions are the replacement for Container Apps Jobs. Read them as committed IaC ' +
      `under infra/aws/ in this repository, or via the \`report-only\` operation of ${RECOVERY_CONSOLE}.`,
  },
  azure_job_update: {
    door: 'arm',
    replacement:
      'ECS task definitions are the replacement for Container Apps Jobs; change them as IaC under ' +
      `infra/aws/ in this repository. Schedule STATE changes go through the \`enable-schedules\` ` +
      `operation of ${RECOVERY_CONSOLE}, which is opt-in by name and has no wildcard.`,
  },
  azure_job_upsert: {
    door: 'arm',
    replacement:
      'ECS task definitions are the replacement for Container Apps Jobs; define them as IaC under ' +
      `infra/aws/ in this repository. Schedule STATE changes go through the \`enable-schedules\` ` +
      `operation of ${RECOVERY_CONSOLE}, which is opt-in by name and has no wildcard.`,
  },
  azure_jobs_list: {
    door: 'arm',
    replacement:
      `Use the \`report-only\` operation of ${RECOVERY_CONSOLE}: it lists every EventBridge schedule ` +
      'with its name, state and group, which is what replaced the Container Apps Jobs fleet.',
  },
  azure_logs_query: {
    door: 'arm',
    replacement:
      'Logs are in CloudWatch, not Log Analytics. The `smoke-test-job` operation of ' +
      `${RECOVERY_CONSOLE} fetches a specific task's own log stream; for ad-hoc queries add a ` +
      'CloudWatch Logs operation there rather than reviving this tool.',
  },
  azure_resource_list: {
    door: 'arm',
    replacement:
      `Use the \`report-only\` operation of ${RECOVERY_CONSOLE} for the live AWS estate, and ` +
      'infra/aws/ in this repository for the committed IaC view of it.',
  },
  azure_search_index_stats: {
    door: 'arm',
    replacement:
      `${OPENSEARCH_NOTE}. Query it through brain_search / kb_search, or reconcile it with the ` +
      'OpenSearch backfill in src/search/opensearch-backfill.ts. Note this tool needs an ARM ' +
      'listQueryKeys call, so unlike the two Azure search WRITE tools it has no direct-key path.',
  },
  azure_search_index_upsert: {
    door: 'arm-or-search-admin-key',
    replacement:
      `${OPENSEARCH_NOTE}; index definitions for it live in src/search/. If you genuinely need to ` +
      'manage a surviving Azure index during a rollback, set AZURE_SEARCH_ADMIN_KEY on the task ' +
      'definition and this tool works again unchanged.',
  },
  azure_search_indexer_upsert: {
    door: 'arm-or-search-admin-key',
    replacement:
      `${OPENSEARCH_NOTE}; the equivalent continuous writer is the OpenSearch backfill/reconciler in ` +
      'src/search/opensearch-backfill.ts. If you genuinely need to manage a surviving Azure indexer ' +
      'during a rollback, set AZURE_SEARCH_ADMIN_KEY on the task definition and this tool works ' +
      'again unchanged.',
  },
});

/** Every reason the ARM door is shut right now. Empty means it is open. Pure; reads env lazily. */
export function armDoorBlockers(): string[] {
  const blockers: string[] = [];
  if (!process.env.IDENTITY_ENDPOINT || !process.env.IDENTITY_HEADER) {
    blockers.push(
      'this runtime has no Azure managed identity (IDENTITY_ENDPOINT/IDENTITY_HEADER are injected ' +
        'only into an Azure Container Apps replica; the gateway runs on ECS Fargate)',
    );
  }
  // Via azureConfig() so this asks the SAME resolved subscription the ARM calls would actually use,
  // rather than re-implementing that fallback and being able to disagree with it.
  if (azureConfig().subscriptionId === DELETED_SUBSCRIPTION_ID) {
    blockers.push(`its ARM target is subscription ${DELETED_SUBSCRIPTION_ID}, which was permanently deleted`);
  }
  return blockers;
}

/**
 * The single guard every azure_* handler calls FIRST. Throws RetiredAzureToolError when the tool
 * cannot possibly reach Azure from this runtime; returns silently when it can.
 *
 * Throws a plain Error for an unregistered name -- a new azure_* tool must make a deliberate
 * decision in RETIRED_AZURE_TOOLS above, and the test enforces that it did.
 */
export function assertAzureToolLive(tool: string): void {
  const entry = RETIRED_AZURE_TOOLS[tool];
  if (!entry) {
    throw new Error(
      `assertAzureToolLive: "${tool}" is not listed in RETIRED_AZURE_TOOLS (src/azure/retired.ts). ` +
        'Every azure_* tool must declare which credential door it depends on and what replaced it.',
    );
  }
  if (entry.door === 'arm-or-search-admin-key' && searchAdminKeyConfigured()) return;

  const blockers = armDoorBlockers();
  if (!blockers.length) return;

  const doorNote =
    entry.door === 'arm-or-search-admin-key'
      ? ' Its only other door, the AZURE_SEARCH_ADMIN_KEY direct key, is not set either.'
      : '';
  throw new RetiredAzureToolError(
    `RETIRED: ${tool} cannot reach Azure from this runtime, because ${blockers.join(', and ')}.` +
      `${doorNote} This is NOT a transient auth or network failure and retrying will not help: ` +
      'the gateway runs as ECS service otchealth-gateway on cluster otchealth in us-east-1, and ' +
      `AWS control-plane operations live in ${RECOVERY_CONSOLE}. ${entry.replacement}`,
    entry.replacement,
  );
}

/** Whether `tool` would refuse right now. Same conditions as assertAzureToolLive, asked as a
 *  question so the advertised description cannot claim something the guard would contradict. */
export function azureToolRetired(tool: string): boolean {
  try {
    assertAzureToolLive(tool);
    return false;
  } catch (err) {
    return err instanceof RetiredAzureToolError;
  }
}

/**
 * The description a retired tool advertises, so a model reading tools/list is steered away BEFORE it
 * spends a call. The call itself still returns the full guidance above.
 *
 * Deliberately CONDITIONAL on the same check the guard uses: if the tool would actually work right
 * now (a search WRITE tool with AZURE_SEARCH_ADMIN_KEY set during a rollback), the catalog must not
 * tell a caller it is dead. A description that disagrees with the runtime is its own small version of
 * the defect this whole change is about.
 */
export function retiredDescription(tool: string, original: string): string {
  if (!azureToolRetired(tool)) return original;
  const entry = RETIRED_AZURE_TOOLS[tool];
  const replacement = entry ? ` ${entry.replacement}` : '';
  return (
    `RETIRED -- DO NOT USE. Azure subscription ${DELETED_SUBSCRIPTION_ID} is gone and this gateway ` +
    `runs on AWS ECS, so this tool fails immediately with a named error instead of doing anything.` +
    `${replacement} (Original description, kept for context: ${original})`
  );
}
