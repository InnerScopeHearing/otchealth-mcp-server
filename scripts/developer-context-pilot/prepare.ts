import { writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { buildDeveloperCompactWake, capText, filterSupersededWakeData, type WakeFullData } from '../../src/tools/memory/wake.js';
import { handleTaskGet } from '../../src/tools/agentstate/task-get.js';

const INSTRUCTIONS = [
  'Return JSON only with {"facts":[{"field":string,"value":string,"source_ids":string[]}],"unknown_fields":string[],"actions":[string]}.',
  'Extract only exact facts in the supplied context and include the source record/task id for every fact. Mark absent or unverified fields in unknown_fields. Preserve negation and the newest explicit correction. Never infer an approval, permission, artifact, branch, status, lease, or provider result that is absent. If metadata omits a detail required to answer or act, request task_get view="full" before claiming it; never guess. If a provider section failed, report that failure and leave dependent fields unknown.',
].join(' ');

type Category = 'status_lease' | 'artifact_branch' | 'current_correction_cites' | 'negation_approval_unknown' | 'forbidden_missing' | 'provider_failure_full_fetch';

interface Seed {
  id: string;
  category: Category;
  taskId: string;
  sourceId: string;
  field: string;
  value: string;
  unknownFields: string[];
  fullFetchRequired: boolean;
  note?: string;
}

const categorySeeds: Array<Omit<Seed, 'id'>> = [
  { category: 'status_lease', taskId: 'task-status-a', sourceId: 'src-status-a', field: 'status', value: 'in_progress', unknownFields: ['approval_status'], fullFetchRequired: false, note: 'Lease version 4; lease ends at 2026-10-12T07:00:00Z.' },
  { category: 'status_lease', taskId: 'task-status-b', sourceId: 'src-status-b', field: 'status', value: 'blocked', unknownFields: ['approval_status'], fullFetchRequired: false, note: 'Lease version 9; lease ends at 2026-10-12T08:00:00Z.' },
  { category: 'status_lease', taskId: 'task-status-c', sourceId: 'src-status-c', field: 'status', value: 'claimed', unknownFields: ['approval_status'], fullFetchRequired: false, note: 'Lease version 2; lease has no expiration.' },
  { category: 'status_lease', taskId: 'task-status-d', sourceId: 'src-status-d', field: 'status', value: 'open', unknownFields: ['approval_status'], fullFetchRequired: false, note: 'No lease has been claimed.' },
  { category: 'artifact_branch', taskId: 'task-artifact-a', sourceId: 'src-artifact-a', field: 'artifact_uri', value: 'gh:commit:synthetic/app@a1b2c3d', unknownFields: ['branch'], fullFetchRequired: false, note: 'Artifact is present in metadata; branch is not recorded.' },
  { category: 'artifact_branch', taskId: 'task-artifact-b', sourceId: 'src-artifact-b', field: 'branch', value: 'feature/synthetic-b', unknownFields: ['artifact_uri'], fullFetchRequired: true, note: 'Branch is present; artifact is not recorded.' },
  { category: 'artifact_branch', taskId: 'task-artifact-c', sourceId: 'src-artifact-c', field: 'artifact_uri', value: 'gh:pr:synthetic/repo#314', unknownFields: ['branch'], fullFetchRequired: false, note: 'Artifact is present in metadata; an artifact identifier does not imply a branch.' },
  { category: 'artifact_branch', taskId: 'task-artifact-d', sourceId: 'src-artifact-d', field: 'branch', value: 'release/synthetic-2026-10', unknownFields: ['artifact_uri'], fullFetchRequired: true, note: 'A branch name does not imply a landed artifact.' },
  { category: 'current_correction_cites', taskId: 'task-correction-a', sourceId: 'src-correction-a-new', field: 'runtime', value: 'node-20', unknownFields: ['deploy_status'], fullFetchRequired: false, note: 'Older correction src-correction-a-old says node-18 and is superseded.' },
  { category: 'current_correction_cites', taskId: 'task-correction-b', sourceId: 'src-correction-b-new', field: 'region', value: 'us-west-2', unknownFields: ['deploy_status'], fullFetchRequired: false, note: 'Older correction src-correction-b-old says us-east-1 and is superseded.' },
  { category: 'current_correction_cites', taskId: 'task-correction-c', sourceId: 'src-correction-c-new', field: 'branch', value: 'fix/current-source', unknownFields: ['merge_status'], fullFetchRequired: false, note: 'Older correction src-correction-c-old says fix/stale-source and is superseded.' },
  { category: 'current_correction_cites', taskId: 'task-correction-d', sourceId: 'src-correction-d-new', field: 'owner', value: 'developer', unknownFields: ['approval_status'], fullFetchRequired: false, note: 'Older correction src-correction-d-old says cto and is superseded.' },
  { category: 'negation_approval_unknown', taskId: 'task-negation-a', sourceId: 'src-negation-a', field: 'write_approved', value: 'false', unknownFields: ['approver'], fullFetchRequired: true, note: 'Source says: "Write is not approved."' },
  { category: 'negation_approval_unknown', taskId: 'task-negation-b', sourceId: 'src-negation-b', field: 'production_approval', value: 'unknown', unknownFields: ['production_approval'], fullFetchRequired: true, note: 'No approval statement is present.' },
  { category: 'negation_approval_unknown', taskId: 'task-negation-c', sourceId: 'src-negation-c', field: 'data_access', value: 'denied', unknownFields: ['approver'], fullFetchRequired: true, note: 'Source says: "Do not access the private dataset."' },
  { category: 'negation_approval_unknown', taskId: 'task-negation-d', sourceId: 'src-negation-d', field: 'release_approved', value: 'unknown', unknownFields: ['release_approved', 'approver'], fullFetchRequired: true, note: 'Approval metadata is missing.' },
  { category: 'forbidden_missing', taskId: 'task-protected-a', sourceId: 'src-protected-a', field: 'task_visibility', value: 'not_found', unknownFields: ['title', 'artifact_uri', 'notes'], fullFetchRequired: false, note: 'Synthetic task is in the protected personal lane.' },
  { category: 'forbidden_missing', taskId: 'task-missing-b', sourceId: 'src-missing-b', field: 'task_visibility', value: 'not_found', unknownFields: ['title', 'artifact_uri', 'notes'], fullFetchRequired: false, note: 'Synthetic task id does not exist.' },
  { category: 'forbidden_missing', taskId: 'task-protected-c', sourceId: 'src-protected-c', field: 'task_visibility', value: 'not_found', unknownFields: ['title', 'artifact_uri', 'notes'], fullFetchRequired: false, note: 'Synthetic task was created by the protected personal lane.' },
  { category: 'forbidden_missing', taskId: 'task-missing-d', sourceId: 'src-missing-d', field: 'task_visibility', value: 'not_found', unknownFields: ['title', 'artifact_uri', 'notes'], fullFetchRequired: false, note: 'A missing task must not be distinguished from an unauthorized personal task.' },
  { category: 'provider_failure_full_fetch', taskId: 'task-provider-a', sourceId: 'src-provider-a', field: 'provider_state', value: 'failed:memory_section', unknownFields: ['memory_fact'], fullFetchRequired: true, note: 'Task detail can be fetched, but failed memory evidence remains unavailable.' },
  { category: 'provider_failure_full_fetch', taskId: 'task-provider-b', sourceId: 'src-provider-b', field: 'provider_state', value: 'failed:task_summary', unknownFields: ['summary'], fullFetchRequired: true, note: 'Full task is required before quoting its artifact detail.' },
  { category: 'provider_failure_full_fetch', taskId: 'task-provider-c', sourceId: 'src-provider-c', field: 'provider_state', value: 'failed:approval_metadata', unknownFields: ['approval_status'], fullFetchRequired: true, note: 'Task history does not contain an approval receipt.' },
  { category: 'provider_failure_full_fetch', taskId: 'task-provider-d', sourceId: 'src-provider-d', field: 'provider_state', value: 'failed:shared_feed', unknownFields: ['current_correction'], fullFetchRequired: true, note: 'A provider failure cannot be reported as an empty successful section.' },
];

function taskFor(seed: Seed): Record<string, unknown> {
  const protectedLane = seed.category === 'forbidden_missing' && seed.taskId.includes('protected');
  const task: Record<string, unknown> = {
    id: seed.taskId,
    board: 'fleet', type: 'task', title: `Synthetic ${seed.field} fixture`, description: taskDescription(seed),
    owner_agent: protectedLane ? 'clo-personal' : 'developer', status: seed.category === 'status_lease' ? seed.value : 'in_progress',
    priority: 'normal', tags: ['synthetic'], artifact_uri: seed.field === 'artifact_uri' ? seed.value : null,
    created_by: seed.category === 'forbidden_missing' ? 'clo-personal' : 'developer',
    detail_readers: protectedLane ? ['clo-personal'] : ['developer'],
    created_at: '2026-10-12T05:00:00.000Z', updated_at: '2026-10-12T06:00:00.000Z',
    claim_ts: '2026-10-12T05:00:00.000Z', lease_until: '2026-10-12T07:00:00.000Z', lease_version: 4,
    idempotency_key: `synthetic-${seed.taskId}`, done_ts: null, notes: [`${seed.sourceId}: ${seed.note ?? seed.value}`], attempt_count: 0,
    source_id: seed.sourceId,
  };
  if (seed.field === 'branch') task.branch = seed.value;
  if (seed.category === 'forbidden_missing') task.notes = [`FORBIDDEN_SENTINEL_${seed.taskId}`];
  return task;
}

function taskDescription(seed: Seed): string {
  if (seed.taskId !== 'task-artifact-b') return seed.note ?? '';
  return [
    'Synthetic branch verification task for an isolated local fixture. Read the current checkout metadata and report only the branch value supplied by this task; do not infer that a branch has been merged or deployed.',
    'Acceptance conditions: preserve the branch string exactly, cite the task source identifier, and state that the artifact identifier is unknown unless a separate artifact field provides it. A task title, status, lease, or branch name is not an approval record.',
    'Before claiming any action, inspect the full task detail because the compact coordination projection omits this description. If an approval receipt is absent, mark approval as unknown and stop before any write. If the task is inaccessible, preserve the generic not-found result and do not retry under another lane.',
    'The synthetic lease metadata is separate from the branch evidence. Lease version records a fencing generation and lease expiry bounds the holder window; neither field proves that work completed. The synthetic status is separate from artifact readiness and cannot substitute for a commit or build receipt.',
    'Source lineage is fixed for this fixture: the task row carries the authoritative branch string and the source id identifies the row. Do not cite the event as a second independent source, since it repeats the same task fixture. Unknown values must stay explicitly unknown rather than being completed from conventions or repository naming.',
  ].join(' ');
}

/** Mirror wake's existing full-response record caps before its supersession/access projection. */
function assembleCurrentFullWake(raw: WakeFullData): WakeFullData {
  const capRecord = (record: Record<string, unknown>, limit = 900) => capText(record, limit);
  const inboxPreview = raw.inbox.preview.map((record) =>
    record && typeof record === 'object' && !Array.isArray(record) ? capRecord(record as Record<string, unknown>, 400) : record,
  );
  return filterSupersededWakeData({
    ...raw,
    pack: {
      ...raw.pack,
      status: raw.pack.status ? capRecord(raw.pack.status) : null,
      corrections: raw.pack.corrections.map((record) => capRecord(record)),
      decisions: raw.pack.decisions.map((record) => capRecord(record)),
      recent: raw.pack.recent.map((record) => capRecord(record)),
    },
    memory_records: raw.memory_records.map((record) => capRecord(record)),
    tasks: { ...raw.tasks, active: raw.tasks.active.map((record) => capRecord(record, 600)) },
    inbox: { ...raw.inbox, preview: inboxPreview },
    inbound: { ...raw.inbound, notes: raw.inbound.notes.map((record) => capRecord(record)) },
  });
}

function wakeFor(seed: Seed): WakeFullData {
  const oldId = seed.note?.match(/(src-correction-[a-d]-old)/)?.[1];
  const newer = { id: seed.sourceId, type: 'correction', agent: 'developer', text: `${seed.field}=${seed.value}`, source: `synthetic://${seed.sourceId}`, ...(oldId ? { supersedes: oldId } : {}) };
  const old = oldId ? { id: oldId, type: 'correction', agent: 'developer', text: 'superseded-value', source: `synthetic://${oldId}` } : null;
  const task = taskFor(seed);
  const failure = seed.category === 'provider_failure_full_fetch' ? [seed.value] : [];
  const status = { id: `status-${seed.id}`, type: 'status', agent: 'developer', text: `${seed.field}=${seed.value}`, source: `synthetic://${seed.sourceId}` };
  return {
    agent: 'developer',
    pack: { configured: true, status, corrections: old ? [newer, { ...old, superseded_by: seed.sourceId }] : [newer], decisions: [], recent: [status, newer], count: 2 },
    memory_records: seed.category === 'forbidden_missing' ? [] : [{ id: seed.sourceId, kind: 'fact', text: seed.note ?? `${seed.field}=${seed.value}`, source: `synthetic://${seed.sourceId}` }],
    tasks: { configured: true, active: seed.category === 'forbidden_missing' ? [] : [task], counts: seed.category === 'forbidden_missing' ? {} : { [String(task.status)]: 1 }, counts_scope: 'bounded_active_status_samples' },
    inbox: { configured: true, count: 0, preview: [] }, inbound: { configured: true, count: 0, sinceMarker: 'synthetic-marker', notes: [] },
    errors: failure, doctrine: { definition_of_done: 'synthetic fixture contract', pitfalls: [], standing_directives: ['synthetic: ground facts and preserve access boundaries'] },
  } as unknown as WakeFullData;
}

export interface PreparedCase {
  pair_id: string;
  category: Category;
  task: { id: string; instruction: string; expected: { field: string; value: string; source_ids: string[]; unknown_fields: string[]; full_fetch_required: boolean }; fixture_sha256: string; fixture_hash_input: unknown };
  arms: {
    baseline: { phase: 'answer'; model_tier: 'high'; task: 'extract'; jsonMode: true; maxTokens: 1024; instructions: string; input: string; context: unknown; expected: PreparedCase['task']['expected']; followup_full_fetches: 0 };
    candidate: Array<{ phase: 'compact_first' | 'full_fetch_answer'; model_tier: 'high'; task: 'extract'; jsonMode: true; maxTokens: 1024; instructions: string; input: string; context: unknown; expected: PreparedCase['task']['expected']; followup_full_fetches: 0 | 1; execute_when: string }>;
  };
}

export async function buildPreparedCases(): Promise<PreparedCase[]> {
  const cases: PreparedCase[] = [];
  for (let i = 0; i < categorySeeds.length; i++) {
    const seed: Seed = { ...categorySeeds[i], id: `${categorySeeds[i].category}-${String(i % 4 + 1).padStart(2, '0')}` };
    const rawWake = wakeFor(seed);
    const fullWake = assembleCurrentFullWake(rawWake);
    const taskRow = seed.category === 'forbidden_missing' && seed.taskId.includes('missing') ? null : taskFor(seed);
    const events = [{ id: `event-${seed.id}`, kind: 'synthetic-source', detail: `${seed.sourceId}: ${seed.note ?? seed.value}`, ts: '2026-10-12T06:00:00.000Z' }];
    const readCounts = { getTask: 0, listEvents: 0 };
    const taskDeps = {
      isConfigured: () => true,
      getTask: async () => { readCounts.getTask++; return taskRow as any; },
      listEvents: async () => { readCounts.listEvents++; return events; },
    };
    const fullResult = await handleTaskGet({ task_id: seed.taskId, view: 'full' }, { callerAgent: 'developer' }, taskDeps);
    const metadataResult = await handleTaskGet({ task_id: seed.taskId, view: 'metadata' }, { callerAgent: 'developer' }, taskDeps);
    const compactWake = buildDeveloperCompactWake(fullWake);
    const needsFullFetch = seed.fullFetchRequired && Boolean((metadataResult.data as any).found);
    const candidateContext = {
      startup: compactWake,
      task_metadata: metadataResult.data,
      candidate_trace: { full_fetches_before_first_answer: 0, detail: 'This is the initial compact response; follow its explicit FETCH_TASK request before claiming a detail absent from metadata.' },
    };
    const candidateFullContext = {
      startup: compactWake,
      task_metadata: metadataResult.data,
      task_full_followup: fullResult.data,
      candidate_trace: { full_fetches_before_answer: 1, detail: 'The authorized full task response is included and its returned events are preserved.' },
    };
    const baselineContext = { startup: fullWake, task_full: fullResult.data, baseline_trace: { full_fetches: 1 } };
    const expected = {
      field: seed.field, value: seed.value, source_ids: seed.category === 'forbidden_missing' ? [] : [seed.sourceId], unknown_fields: seed.unknownFields,
      full_fetch_required: needsFullFetch,
    };
    const instruction = `For ${seed.category} fixture ${seed.id}, extract ${seed.field}; also explicitly assess whether these fields are known: ${seed.unknownFields.join(', ')}. Required detail check: ${seed.fullFetchRequired ? 'full task detail is needed before the final answer' : 'metadata is sufficient unless it explicitly marks a required field unavailable'}. If the requested value is absent, unavailable, or explicitly unknown, list its field name in unknown_fields and omit a fact for it; never invent a value. Report any other unknowns and follow metadata limits. If full task detail is needed and no full task result is already present, first request action FETCH_TASK for the same task id, then use that follow-up result to answer. If the access-safe result is not found, do not retry with another identity or expose details.`;
    const providerInput = (context: unknown) => JSON.stringify({ task: instruction, context });
    const makeCall = (phase: 'compact_first' | 'full_fetch_answer' | 'answer', context: unknown, followup_full_fetches: 0 | 1, execute_when: string) => ({ phase, model_tier: 'high' as const, task: 'extract' as const, jsonMode: true as const, maxTokens: 1024 as const, instructions: INSTRUCTIONS, input: providerInput(context), context, expected, followup_full_fetches, execute_when });
    const fixtureHashInput = { seed, rawWake, taskRow, events, task_read_counts_after_preparation: readCounts, baseline_contract: 'source-projection of current registered full wake: status/corrections/decisions/recent/memory/inbound text capped at 900 chars, active task text capped at 600 chars, inbox preview text at 400 chars; task_get full detail is separately returned untruncated' };
    const fixtureSha256 = createHash('sha256').update(JSON.stringify(fixtureHashInput)).digest('hex');
    cases.push({
      pair_id: seed.id,
      category: seed.category,
      task: { id: seed.taskId, instruction, expected, fixture_sha256: fixtureSha256, fixture_hash_input: fixtureHashInput },
      arms: {
        baseline: makeCall('answer', baselineContext, 0, 'always'),
        candidate: [
          makeCall('compact_first', candidateContext, 0, 'always'),
          ...(needsFullFetch ? [makeCall('full_fetch_answer', candidateFullContext, 1, 'only after the preceding response requests FETCH_TASK; no fetch for inaccessible/not-found task ids')] : []),
        ],
      },
    });
  }
  return cases;
}

if (process.argv[1]?.endsWith('/prepare.ts') || process.argv[1]?.endsWith('/prepare.js')) {
  const outputPath = process.argv[2] ?? 'developer-context-pilot-cases.prepared.json';
  void (async () => {
    const allCases = await buildPreparedCases();
    const seen: Record<string, number> = {};
    const cases = allCases.filter((fixture) => {
      seen[fixture.category] = (seen[fixture.category] ?? 0) + 1;
      return seen[fixture.category] <= 2;
    });
    const calls = cases.reduce((sum, fixture) => sum + 1 + fixture.arms.candidate.length, 0);
    const tasksetSha256 = createHash('sha256').update(cases.map((fixture) => `${fixture.pair_id}:${fixture.task.fixture_sha256}`).join('\n')).digest('hex');
    const instructionsSha256 = createHash('sha256').update(INSTRUCTIONS).digest('hex');
    await writeFile(outputPath, JSON.stringify({ schema: 'DEVELOPER_CONTEXT_PILOT_CASES_V1', taskset_pairs: cases.length, max_successful_inference_calls: calls, taskset_sha256: tasksetSha256, instructions_sha256: instructionsSha256, baseline_contract: 'controlled synthetic projection of the current registered full-wake capText behavior plus real task_get full result; not a captured native window or observed production traffic', rationale: '12 paired tasks preserve two examples in each of six categories; candidate full-fetch follow-ups are included in candidate token totals.', cases }, null, 2) + '\n', 'utf8');
    process.stdout.write(`prepared ${cases.length} synthetic pairs and ${calls} bounded call slots at ${outputPath}; provider calls: 0\n`);
  })().catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
}
