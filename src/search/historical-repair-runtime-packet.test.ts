import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { HISTORICAL_REPAIR_RUNTIME_CONTRACT } from './historical-repair-cli.js';

const packet = JSON.parse(readFileSync('tools/historical-repair/runtime-packet.json', 'utf8')) as Record<string, any>;
const schedules = JSON.parse(readFileSync('infra/aws/data/schedules.json', 'utf8')) as Record<string, any>;

test('runtime packet targets the existing disabled brain repair schedule', () => {
  const job = packet.existing_job;
  const schedule = schedules[job.schedule_name];
  assert.ok(schedule);
  assert.equal(schedule.state, 'DISABLED');
  assert.equal(schedule.target.taskDefinitionFamily, job.task_definition_family);
  assert.equal(job.required_schedule_state, 'DISABLED');
  assert.equal(job.retired_task_definition_is_not_a_source, true);
  assert.doesNotMatch(job.container_source, /azure/i);
});

test('runtime packet uses only the compiled durable CLI and keeps execution explicit', () => {
  const commands = packet.commands as Record<string, string[]>;
  for (const command of Object.values(commands)) {
    assert.equal(command[0], 'node');
    assert.equal(command[1], packet.compiled_entrypoint);
    assert.equal(command.includes('tsx'), false);
    assert.equal(command.includes('--durable'), true);
    assert.deepEqual(command.slice(command.indexOf('--agent'), command.indexOf('--agent') + 2), ['--agent', 'cfo']);
  }
  assert.equal(commands.preflight.includes('--preflight'), true);
  assert.equal(commands.preflight.includes('--execute'), false);
  assert.equal(commands.dry_run.includes('--execute'), false);
  assert.equal(commands.execute.includes('--execute'), true);
  assert.equal(packet.artifact_gate.required_runtime_contract, HISTORICAL_REPAIR_RUNTIME_CONTRACT);
  assert.match(packet.artifact_gate.source_revision, /exact merged PR 344 commit/);
  assert.match(packet.artifact_gate.image_reference, /immutable ECR sha256 digest/);
  assert.equal(packet.artifact_gate.reject_mutable_or_older_image, true);
  assert.equal('minimum_source_commit' in packet, false);
});

test('runtime packet carries identifiers and secret names without values or protected lanes', () => {
  assert.equal(packet.checkpoint.contains_source_text, false);
  assert.equal(packet.checkpoint.dry_run_writes, false);
  assert.equal(packet.checkpoint.ttl, -1);
  assert.equal(packet.checkpoint.execute_lease_seconds, 7200);
  assert.match(packet.checkpoint.renewal_policy, /before every embedding or projection write dispatch/);
  assert.ok(packet.checkpoint.maximum_embedding_request_seconds < packet.checkpoint.execute_lease_seconds);
  assert.equal(packet.execute_budget.maximum_source_rows, 25);
  assert.equal(packet.execute_budget.maximum_new_embedding_texts, 25);
  assert.match(packet.execute_budget.approval_gate, /dry run/);
  assert.equal(packet.excluded_agents.includes('clo-personal'), true);
  const serialized = JSON.stringify(packet);
  assert.equal(serialized.includes('personal-legal'), false);
  assert.deepEqual(packet.required_secret_names, ['PG_PASSWORD', 'OPENAI_API_KEY']);
  assert.equal(Object.keys(packet).some(key => /secret_value/i.test(key)), false);
});

test('gateway image build includes the compiled entrypoint source in dist', () => {
  const dockerfile = readFileSync('Dockerfile', 'utf8');
  const source = readFileSync('src/search/historical-repair-cli.ts', 'utf8');
  assert.match(dockerfile, /COPY --from=build --chown=app:app \/app\/dist \.\/dist/);
  assert.match(source, /historicalRepairCheckpointStore/);
});
