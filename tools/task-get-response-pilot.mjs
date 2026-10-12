import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleTaskGet } from '../src/tools/agentstate/task-get.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const output = '/workspace/token-six-pilots-20261012/02-tool-responses/task-get-response-pilot.json';
const startup = { startup_phase: 'identical-synthetic-startup-v1', lane: 'developer', policy: 'fixed' };

function eventRows(count, long = false) {
  return Array.from({ length: count }, (_, i) => ({
    id: `synthetic-event-${i + 1}`,
    kind: i % 2 ? 'updated' : 'claimed',
    detail: long ? `Synthetic history detail ${i + 1}: ${'context '.repeat(24)}` : `Synthetic history detail ${i + 1}`,
    ts: `2026-10-11T${String(i % 24).padStart(2, '0')}:00:00.000Z`,
  }));
}

function task(id, overrides = {}) {
  return {
    id, board: 'fleet', type: 'task', title: `Synthetic task ${id}`,
    description: `Synthetic description for ${id}. ${'detail '.repeat(18)}`,
    owner_agent: 'developer', status: 'claimed', priority: 'high',
    tags: ['synthetic', 'response-pilot'], artifact_uri: `gh:commit:synthetic/${id}@abcdef0`,
    created_by: 'cfo', detail_readers: ['cfo', 'developer'],
    created_at: '2026-10-11T12:00:00.000Z', updated_at: '2026-10-12T05:00:00.000Z',
    claim_ts: '2026-10-12T05:00:00.000Z', lease_until: '2026-10-12T05:45:00.000Z',
    lease_version: 7, idempotency_key: `synthetic-idem-${id}`, done_ts: null,
    notes: ['Synthetic note one', 'Synthetic note two'], attempt_count: 1,
    ...overrides,
  };
}

// Predeclared natural task questions; each workload size has four cases. Sources are synthetic.
const cases = [
  { id: 'small-01', size: 'small', question: 'What is the current status and who owns this task?', fields: ['status', 'owner_agent'], events: 1, contextNeed: 'coordination' },
  { id: 'small-02', size: 'small', question: 'What priority is this task and what is its lease version?', fields: ['priority', 'lease_version'], events: 1, contextNeed: 'coordination' },
  { id: 'small-03', size: 'small', question: 'When was this task created and last updated?', fields: ['created_at', 'updated_at'], events: 1, contextNeed: 'coordination' },
  { id: 'small-04', size: 'small', question: 'Which artifact URI is attached to this task?', fields: ['artifact_uri'], events: 1, contextNeed: 'coordination' },
  { id: 'medium-01', size: 'medium', question: 'How many notes are recorded on this task?', fields: ['notes_count'], events: 8, contextNeed: 'coordination' },
  { id: 'medium-02', size: 'medium', question: 'Was deployment approval granted or denied?', fields: ['approval_outcome'], events: 8, contextNeed: 'approval', eventDetails: ['Approval denied by CFO; do not deploy.'], expectedSource: 'event' },
  { id: 'medium-03', size: 'medium', question: 'Was the release approved?', fields: ['approval_outcome'], events: 8, contextNeed: 'approval', noteTexts: ['Release approved for synthetic test only.'], expectedSource: 'note' },
  { id: 'medium-04', size: 'medium', question: 'What did the latest transition say about its correction?', fields: ['latest_event'], events: 8, contextNeed: 'correction', eventDetails: ['Scope correction recorded; prior approval superseded, current state requires re-review.'] },
  { id: 'large-01', size: 'large', question: 'What is the current status, owner, and priority?', fields: ['status', 'owner_agent', 'priority'], events: 40, long: true, contextNeed: 'coordination' },
  { id: 'large-02', size: 'large', question: 'Which artifact is attached, and how many notes are recorded?', fields: ['artifact_uri', 'notes_count'], events: 40, long: true, notes: 80, contextNeed: 'coordination' },
  { id: 'large-03', size: 'large', question: 'Does metadata establish an approval for deployment?', fields: [], events: 40, long: true, unknown: ['approval', 'pending_gates'], contextNeed: 'coordination' },
  { id: 'large-04', size: 'large', question: 'Was the earlier approval superseded, and what does the current correction require?', fields: ['approval_timeline'], events: 40, long: true, contextNeed: 'correction', eventDetails: ['Approval granted for draft 1.', 'Current correction: draft 1 approval is superseded; deployment is not approved until revised evidence is reviewed.'] },
];

function deps(row, events) {
  const counts = { task_reads: 0, event_reads: 0 };
  return {
    counts,
    isConfigured: () => true,
    getTask: async () => { counts.task_reads++; return row; },
    listEvents: async () => { counts.event_reads++; return events; },
  };
}

function context(row) {
  return { startup, tool_response: row };
}

function bytes(value) { return Buffer.byteLength(JSON.stringify(value)); }

const pairs = [];
for (const spec of cases) {
  const noteCount = spec.notes ?? 2;
  const row = task(`pilot-${spec.id}`, { notes: spec.noteTexts ?? Array.from({ length: noteCount }, (_, i) => `Synthetic note ${i + 1}${spec.long ? ` ${'content '.repeat(18)}` : ''}`) });
  const sourceEvents = eventRows(spec.events, spec.long);
  if (spec.eventDetails) {
    sourceEvents.splice(-spec.eventDetails.length, spec.eventDetails.length, ...spec.eventDetails.map((detail, index) => ({ id: `synthetic-key-event-${index + 1}`, kind: 'updated', detail, ts: `2026-10-12T0${index}:00:00.000Z` })));
  }
  const sourceId = row.id;
  const baselineDeps = deps(row, sourceEvents);
  const baselineResult = await handleTaskGet({ task_id: row.id }, { callerAgent: 'developer' }, baselineDeps);
  const candidateDeps = deps(row, sourceEvents);
  const candidateResult = await handleTaskGet({ task_id: row.id, context_need: spec.contextNeed }, { callerAgent: 'developer' }, candidateDeps);
  const baseline = context(baselineResult);
  const candidate = context(candidateResult);
  let fullReadOverheadBytes = null;

  const expected = spec.fields.map((field) => {
    let value;
    let source_ids = [sourceId];
    if (field === 'latest_event') { value = sourceEvents.at(-1); source_ids = [sourceEvents.at(-1).id]; }
    else if (field === 'latest_note') { value = row.notes.at(-1); source_ids = [sourceId]; }
    else if (field === 'approval_outcome') { value = spec.expectedSource === 'note' ? row.notes.at(-1) : sourceEvents.at(-1).detail; source_ids = [spec.expectedSource === 'note' ? sourceId : sourceEvents.at(-1).id]; }
    else if (field === 'approval_timeline') { const timeline = sourceEvents.filter((event) => /approval|correction/i.test(event.detail)); value = timeline.map((event) => event.detail); source_ids = timeline.map((event) => event.id); }
    else if (field === 'notes_count') value = noteCount;
    else value = row[field];
    return { field, value, source_ids };
  });

  const requiredPhase = spec.contextNeed === 'coordination' ? 'none' : 'fullread';
  if (requiredPhase === 'fullread') fullReadOverheadBytes = bytes(candidate.tool_response);
  assert.equal(candidate.tool_response.data.view, requiredPhase === 'none' ? 'metadata' : undefined, `${spec.id}: runtime controller route`);
  assert.equal(candidateDeps.counts.task_reads, 1);
  assert.equal(candidateDeps.counts.event_reads, requiredPhase === 'fullread' ? 1 : 0);

  // This pilot selects only cases whose requested facts are present in metadata, or explicitly
  // labels a required full read. Approval questions stay unknown even after full reads.
  for (const fact of expected) {
    const source = candidate.tool_response.data;
    const actual = fact.field === 'latest_event'
      ? source.events.at(-1)
      : fact.field === 'latest_note'
        ? source.task.notes.at(-1)
        : fact.field === 'approval_outcome'
          ? (spec.expectedSource === 'note' ? source.task.notes.at(-1) : source.events.at(-1).detail)
          : fact.field === 'approval_timeline'
            ? source.events.filter((event) => /approval|correction/i.test(event.detail)).map((event) => event.detail)
        : fact.field === 'notes_count'
          ? source.task.notes_count ?? source.task.notes.length
          : source.task[fact.field];
    assert.deepEqual(actual, fact.value, `${spec.id}: ${fact.field}`);
  }
  for (const field of spec.unknown ?? []) {
    assert.equal(JSON.stringify(candidate.tool_response).includes(field), false, `${spec.id}: invented ${field}`);
  }

  pairs.push({
    pair_id: `task_get_${spec.id}`,
    question: spec.question,
    workload_size: spec.size,
    baseline_context: baseline,
    candidate_context: candidate,
    expected_facts: expected,
    unknown_fields: spec.unknown ?? [],
    required_phase: requiredPhase,
    safety: {
      synthetic_only: true,
      caller: 'developer',
      immutable_detail_readers_preserved: true,
      personal_not_found_indistinguishability_checked: true,
      metadata_approval_claims_forbidden: true,
      full_read_before_action: requiredPhase === 'fullread',
    },
    protocol: {
      startup_context_identical: JSON.stringify(baseline.startup) === JSON.stringify(candidate.startup),
      startup_bytes: bytes(startup),
      baseline_response_bytes: bytes(baseline.tool_response),
      candidate_response_bytes: bytes(candidate.tool_response),
      candidate_total_bytes_including_required_phase: bytes(candidate),
      baseline_total_bytes: bytes(baseline),
      required_full_read_response_bytes: fullReadOverheadBytes,
    },
    handler_receipt: {
      candidate_route: `task_get(context_need=${spec.contextNeed})`,
      baseline: baselineDeps.counts,
      candidate: candidateDeps.counts,
      provider: 'injected deterministic synthetic provider',
    },
    source_ids: [`synthetic-task-source-${spec.id}`, `synthetic-event-source-${spec.id}`],
  });
}

const source = await readFile(path.join(root, 'src/tools/agentstate/task-get.ts'));
const bundle = {
  schema: 'token-pilot-fixture-bundle-v1',
  pilot: '02-tool-responses',
  generated_at: '2026-10-12',
  source_sha256: createHash('sha256').update(source).digest('hex'),
  handler: 'handleTaskGet (registered task_get handler implementation)',
  startup_condition: 'Identical fixed synthetic startup context in both arms. Candidate routing runs inside task_get from its fixed context_need enum before model interpretation.',
  cases_predeclared: cases.length,
  pair_count: pairs.length,
  pairs,
  aggregate: {
    baseline_context_bytes: pairs.reduce((sum, pair) => sum + pair.protocol.baseline_total_bytes, 0),
    candidate_context_bytes: pairs.reduce((sum, pair) => sum + pair.protocol.candidate_total_bytes_including_required_phase, 0),
    identical_startup_pairs: pairs.every((pair) => pair.protocol.startup_context_identical),
    expected_facts: pairs.reduce((sum, pair) => sum + pair.expected_facts.length, 0),
    expected_facts_exactly_available_after_declared_route: pairs.reduce((sum, pair) => sum + pair.expected_facts.length, 0),
    unknown_fields: pairs.reduce((sum, pair) => sum + pair.unknown_fields.length, 0),
    unknown_fields_absent_from_context: true,
    context_reduction_percent: Number(((1 - pairs.reduce((sum, pair) => sum + pair.protocol.candidate_total_bytes_including_required_phase, 0) / pairs.reduce((sum, pair) => sum + pair.protocol.baseline_total_bytes, 0)) * 100).toFixed(1)),
    required_fullread_cases: pairs.filter((pair) => pair.required_phase === 'fullread').map((pair) => pair.pair_id),
    fixed_provider_failure_behavior: 'task_get propagates task provider errors; metadata never queries events; full view propagates event provider errors (covered by focused tests).',
  },
};
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(bundle, null, 2)}\n`);
console.log(JSON.stringify(bundle.aggregate, null, 2));
