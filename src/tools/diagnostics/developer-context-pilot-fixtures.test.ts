import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { buildPreparedCases } from '../../../scripts/developer-context-pilot/prepare.js';

function selectedPilotCases(prepared: Awaited<ReturnType<typeof buildPreparedCases>>) {
  const seen = new Map<string, number>();
  return prepared.filter((fixture) => {
    const count = seen.get(fixture.category) ?? 0;
    seen.set(fixture.category, count + 1);
    return count < 2;
  });
}

function fixtureReceipts(pairs: ReturnType<typeof selectedPilotCases>, opts: { costlyRegression?: boolean } = {}) {
  const tasksetSha = createHash('sha256').update(pairs.map((fixture) => `${fixture.pair_id}:${fixture.task.fixture_sha256}`).join('\n')).digest('hex');
  const rows: any[] = [];
  for (let i = 0; i < pairs.length; i++) {
    const fixture = pairs[i];
    const outlier = opts.costlyRegression && i === 0;
    const baselineTokens = outlier ? 1000 : 100;
    const candidateTokens = outlier ? 1000 : 70;
    rows.push({ pair_id: fixture.pair_id, arm: 'baseline', phase: 'answer', status: 'success', taskset_sha256: tasksetSha, unknown_outcomes: 0, hidden_physical_attempts: 'unobservable', returned_model: 'gpt-5.6-sol', usage: { prompt_tokens: baselineTokens, completion_tokens: 10, total_tokens: baselineTokens + 10, cached_tokens: 0 }, quality_pass: true, critical_failures: [], cache_hit: false, deflected: false });
    const followupRequired = fixture.arms.candidate.length > 1;
    for (let j = 0; j < fixture.arms.candidate.length; j++) {
      const candidateCall = fixture.arms.candidate[j];
      const promptTokens = followupRequired ? (j === 0 ? Math.floor(candidateTokens * 0.4) : candidateTokens - Math.floor(candidateTokens * 0.4)) : candidateTokens;
      rows.push({ pair_id: fixture.pair_id, arm: 'candidate', phase: candidateCall.phase, followup_required: followupRequired, requested_action: candidateCall.phase === 'compact_first' && followupRequired ? 'FETCH_TASK' : null, followup_triggered_by_fetch: candidateCall.phase === 'full_fetch_answer', status: 'success', taskset_sha256: tasksetSha, unknown_outcomes: 0, hidden_physical_attempts: 'unobservable', returned_model: 'gpt-5.6-sol', usage: { prompt_tokens: promptTokens, completion_tokens: 8, total_tokens: promptTokens + 8, cached_tokens: 0 }, quality_pass: true, critical_failures: [], cache_hit: false, deflected: false });
    }
  }
  return { rows, tasksetSha, pairIds: pairs.map((fixture) => fixture.pair_id) };
}

function runScorer(rows: any[], pairIds: string[], tasksetSha: string) {
  const python = [
    'import json,sys',
    "sys.path.insert(0,'scripts/developer-context-pilot')",
    'from score import score',
    'p=json.load(sys.stdin)',
    'print(json.dumps(score(p[\"rows\"],p[\"pair_ids\"],p[\"taskset_sha\"])))',
  ].join(';');
  const child = spawnSync('python3', ['-c', python], { cwd: process.cwd(), input: JSON.stringify({ rows, pair_ids: pairIds, taskset_sha: tasksetSha }), encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  return JSON.parse(child.stdout);
}

test('prepared pilot uses real startup and task projections with 12 pairs and bounded follow-up calls', async () => {
  const prepared = await buildPreparedCases();
  const counts = new Map<string, number>();
  for (const fixture of prepared) counts.set(fixture.category, (counts.get(fixture.category) ?? 0) + 1);
  assert.equal(prepared.length, 24, 'fixture library contains four authored examples per category');
  assert.deepEqual([...counts.values()], Array(6).fill(4));

  const pilot: typeof prepared = [];
  const selected = new Map<string, number>();
  for (const fixture of prepared) {
    const seen = selected.get(fixture.category) ?? 0;
    if (seen < 2) pilot.push(fixture);
    selected.set(fixture.category, seen + 1);
  }
  assert.equal(pilot.length, 12);
  const logicalCallSlots = pilot.reduce((sum, fixture) => sum + 1 + fixture.arms.candidate.length, 0);
  assert.ok(logicalCallSlots <= 32, `baseline + candidate follow-ups ${logicalCallSlots} must fit the pilot cap`);
  assert.ok(pilot.some((fixture) => fixture.arms.candidate.length === 2), 'candidate full-fetch answer calls are retained in the measured sample');

  for (const fixture of pilot) {
    const { baseline, candidate } = fixture.arms;
    const baselineContext = baseline.context as any;
    const candidateContext = candidate[0].context as any;
    assert.equal(baseline.model_tier, 'high');
    assert.equal(candidate[0].model_tier, 'high');
    assert.equal(baseline.task, 'extract');
    assert.equal(candidate[0].task, 'extract');
    assert.equal(baseline.instructions, candidate[0].instructions);
    assert.equal(baseline.jsonMode, candidate[0].jsonMode);
    assert.equal(baseline.maxTokens, candidate[0].maxTokens);
    assert.equal(baseline.expected.field, fixture.task.expected.field);
    assert.match(fixture.task.fixture_sha256, /^[a-f0-9]{64}$/);
    assert.deepEqual(candidate[0].expected, baseline.expected);
    assert.ok(JSON.stringify(candidateContext).includes('developer_compact'));
    assert.equal(baseline.followup_full_fetches, 0);
    assert.equal(candidate[0].followup_full_fetches, 0);
    if (candidate.length === 2) {
      assert.equal(candidate[1].phase, 'full_fetch_answer');
      assert.equal(candidate[1].followup_full_fetches, 1);
      assert.match(candidate[1].execute_when, /only after the preceding response requests FETCH_TASK/);
      assert.ok(JSON.stringify(candidate[1].context).includes('task_full_followup'));
    } else {
      assert.equal(fixture.task.expected.full_fetch_required, false);
    }
    if (fixture.category === 'forbidden_missing') {
      assert.equal(baselineContext.task_full.found, false);
      assert.equal(candidateContext.task_metadata.found, false);
      assert.equal(JSON.stringify(candidate).includes('FORBIDDEN_SENTINEL'), false);
      assert.equal(JSON.stringify(baseline).includes('FORBIDDEN_SENTINEL'), false);
    }
    if (fixture.category === 'provider_failure_full_fetch') {
      assert.ok(baselineContext.startup.errors.length > 0);
      assert.equal(candidateContext.startup.errors.length, baselineContext.startup.errors.length);
    }
    if (fixture.category === 'current_correction_cites') {
      const compactCorrections = candidateContext.startup.pack.corrections;
      assert.ok(compactCorrections.some((row: any) => row.id === fixture.task.expected.source_ids[0]));
      assert.ok(compactCorrections.every((row: any) => !row.id.includes('-old')));
    }
    if (fixture.pair_id === 'artifact_branch-02') {
      const baselineDescription = baselineContext.task_full.task.description;
      const startupDescription = baselineContext.startup.tasks.active[0].description;
      const candidateFollowupDescription = (candidate[1].context as any).task_full_followup.task.description;
      assert.ok(baselineDescription.length > 900, 'baseline full task detail exceeds the source text cap boundary');
      assert.equal(startupDescription, baselineDescription, 'existing capText behavior does not cap task description fields');
      assert.equal(candidateFollowupDescription, baselineDescription, 'full fetch preserves the same long task detail in the candidate arm');
    }
  }
});

test('prepared provider inputs use one immutable instruction frame and no fabricated token counts', async () => {
  const prepared = await buildPreparedCases();
  for (const fixture of prepared) {
    for (const call of [fixture.arms.baseline, ...fixture.arms.candidate]) {
      assert.match(call.input, /"task":"For /);
      assert.equal('input_tokens' in (call as any), false);
      assert.equal('estimated_tokens' in (call as any), false);
      assert.equal(call.instructions, fixture.arms.baseline.instructions);
    }
    assert.ok(fixture.task.expected.source_ids.every((id) => id.startsWith('src-')));
    assert.ok(fixture.task.expected.unknown_fields.length > 0);
    if (fixture.category === 'forbidden_missing') assert.deepEqual(fixture.task.expected.source_ids, []);
  }
});

test('weighted input-token gate blocks a costly outlier that an unweighted mean would hide', async () => {
  const pairs = selectedPilotCases(await buildPreparedCases());
  const receipt = fixtureReceipts(pairs, { costlyRegression: true });
  const score = runScorer(receipt.rows, receipt.pairIds, receipt.tasksetSha);
  assert.ok(score.pairs.every((pair: any) => pair.complete_pair));
  assert.equal(score.prompt_point_estimate_gate_pass, false);
  assert.equal(score.accepted_for_bounded_logical_gateway_pilot_only, false);
  assert.equal(score.physical_attempt_usage.startsWith('unobservable'), true);
  assert.equal(score.native_chat_result.startsWith('unverified'), true);
});

test('quality gate requires all baseline and candidate answers to pass, not only a nonworse count', async () => {
  const pairs = selectedPilotCases(await buildPreparedCases());
  const rows = fixtureReceipts(pairs).rows;
  const first = pairs[0].pair_id;
  for (const row of rows.filter((entry) => entry.pair_id === first)) row.quality_pass = false;
  const score = runScorer(rows, pairs.map((pair) => pair.pair_id), createHash('sha256').update(pairs.map((fixture) => `${fixture.pair_id}:${fixture.task.fixture_sha256}`).join('\n')).digest('hex'));
  assert.equal(score.quality_pass_count_not_worse, true, '0/0 is numerically not worse');
  assert.equal(score.all_12_baseline_and_candidate_quality_gates_pass, false);
  assert.equal(score.accepted_for_bounded_logical_gateway_pilot_only, false);
});

test('scorer blocks missing outcome counters, extra cases, duplicate phases, and mixed models', async () => {
  const pairs = selectedPilotCases(await buildPreparedCases());
  const base = fixtureReceipts(pairs);
  const missingCounter = structuredClone(base.rows);
  delete missingCounter[0].unknown_outcomes;
  assert.equal(runScorer(missingCounter, base.pairIds, base.tasksetSha).receipt_contract_pass, false);

  const extraCase = structuredClone(base.rows);
  extraCase.push({ ...extraCase[0], pair_id: 'unexpected-extra', taskset_sha256: base.tasksetSha });
  assert.equal(runScorer(extraCase, base.pairIds, base.tasksetSha).accepted_for_bounded_logical_gateway_pilot_only, false);

  const duplicatePhase = structuredClone(base.rows);
  duplicatePhase.push({ ...duplicatePhase.find((row) => row.arm === 'candidate' && row.phase === 'compact_first') });
  assert.equal(runScorer(duplicatePhase, base.pairIds, base.tasksetSha).accepted_for_bounded_logical_gateway_pilot_only, false);

  const mixedModel = structuredClone(base.rows);
  mixedModel.find((row) => row.arm === 'candidate').returned_model = 'other-model';
  assert.equal(runScorer(mixedModel, base.pairIds, base.tasksetSha).accepted_for_bounded_logical_gateway_pilot_only, false);

  const malformedExtra = structuredClone(base.rows);
  malformedExtra.push({ ...malformedExtra[0], pair_id: 'unknown-pair', arm: 'unknown-arm' });
  const malformedScore = runScorer(malformedExtra, base.pairIds, base.tasksetSha);
  assert.equal(malformedScore.accepted_for_bounded_logical_gateway_pilot_only, false);
  assert.equal(malformedScore.attempts_included, malformedExtra.length, 'malformed supplied rows still count against the cap');
  assert.ok(malformedScore.blocked_reasons.some((reason: string) => reason.includes('pair_id/arm invalid')));
  const overCap = [...base.rows, ...Array.from({ length: 4 }, () => ({ pair_id: null, arm: 'unknown' }))];
  const overCapScore = runScorer(overCap, base.pairIds, base.tasksetSha);
  assert.equal(overCapScore.attempts_included, overCap.length);
  assert.ok(overCapScore.blocked_reasons.some((reason: string) => reason.includes('32-call pilot cap')));
  assert.equal(overCapScore.accepted_for_bounded_logical_gateway_pilot_only, false);

  const missingFetchAction = structuredClone(base.rows);
  const firstFollowupPair = base.pairIds.find((id) => missingFetchAction.some((row) => row.pair_id === id && row.phase === 'full_fetch_answer'))!;
  missingFetchAction.find((row) => row.pair_id === firstFollowupPair && row.phase === 'compact_first').requested_action = null;
  assert.equal(runScorer(missingFetchAction, base.pairIds, base.tasksetSha).accepted_for_bounded_logical_gateway_pilot_only, false);

  const missingOptionalUsage = structuredClone(base.rows);
  delete missingOptionalUsage[0].usage.completion_tokens;
  delete missingOptionalUsage[0].usage.total_tokens;
  delete missingOptionalUsage[0].usage.cached_tokens;
  const optionalScore = runScorer(missingOptionalUsage, base.pairIds, base.tasksetSha);
  assert.equal(optionalScore.accepted_for_bounded_logical_gateway_pilot_only, true, 'missing optional counters do not block input-only qualification');
  assert.equal(optionalScore.token_totals.baseline.completion_tokens_reported_sum, null);
  assert.equal(optionalScore.token_totals.baseline.cached_tokens_reported_sum_subset_of_prompt, null);
  assert.equal(optionalScore.all_token_reduction_point_estimate, null);
});
