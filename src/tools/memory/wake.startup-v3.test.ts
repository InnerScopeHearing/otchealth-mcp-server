import test from 'node:test';
import assert from 'node:assert/strict';
import { buildStartupCompactWake, type WakeFullData, registerWake } from './wake.js';
import { requestContext } from '../../server/request-context.js';
import { buildTextContent } from '../registry.js';

const make = (overrides: Partial<WakeFullData> = {}): WakeFullData => ({
  agent: 'developer',
  pack: { configured: true, status: { id: 's1', type: 'status', text: 'paused', source: 'feed-A', agent: 'developer', timestamp: '2026-10-12T08:00:00Z' }, corrections: [{ id: 'c1', type: 'correction', text: 'Use signed manifest', was: 'Use unsigned manifest', source: 'feed-A', agent: 'developer', timestamp: '2026-10-12T08:01:00Z', supersedes: 'c0' }], decisions: [{ id: 'd1', type: 'decision', text: 'Approval remains unknown', approval_state: 'unknown', source: 'feed-B', agent: 'developer', timestamp: '2026-10-12T08:02:00Z' }], recent: [{ id: 's1', type: 'status', text: 'paused', source: 'feed-A', agent: 'developer', timestamp: '2026-10-12T08:00:00Z' }, { id: 'c1', type: 'correction', text: 'Use signed manifest', was: 'Use unsigned manifest', source: 'feed-A', agent: 'developer', timestamp: '2026-10-12T08:01:00Z', supersedes: 'c0' }, { id: 'f1', type: 'fact', text: 'Check source before action', source: 'feed-A', agent: 'developer', timestamp: '2026-10-12T08:03:00Z' }], count: 3 },
  memory_records: [{ id: 'm1', kind: 'fact', text: 'Provider output unavailable', source: 'store-A', agent: 'developer', timestamp: '2026-10-12T08:04:00Z', truncated: true, _rid: 'synthetic-rid', review_state: 'unknown' }],
  tasks: { configured: true, active: [{ id: 't1', board: 'developer', type: 'task', owner_agent: 'developer', created_by: 'developer', detail_readers: ['developer'], status: 'blocked', priority: 'high', title: 'Check gate', description: 'Do not proceed until approval is present.', notes: ['No approval recorded.'], artifact_uri: 'artifact://synthetic/t1', blocker: 'approval_missing', created_at: '2026-10-12T07:00:00Z', updated_at: '2026-10-12T08:00:00Z' }], counts: { blocked: 1 } },
  inbox: { configured: true, count: 1, preview: [{ message_id: 'i1', from: 'cto', subject: 'Review', body: 'Please verify; this is only a peek.', ts: '2026-10-12T08:05:00Z' }] },
  inbound: { configured: true, count: 1, sinceMarker: 'mark-1', notes: [{ id: 'n1', text: 'Unreconciled note', by: 'cto', source: 'feed-B', timestamp: '2026-10-12T08:06:00Z' }] },
  errors: ['provider: result unknown'],
  doctrine: { definition_of_done: 'complete + verified', pitfalls: [{ id: 'p1', text: 'Cite source ids.' }], standing_directives: ['Preserve unknown states.'] },
  ...overrides,
});

test('compact view preserves exact operative record values, ids, times, unknowns, corrections and errors', () => {
  const full = make();
  const before = structuredClone(full);
  const compact = buildStartupCompactWake(full) as any;
  assert.equal(compact.pack.status.id, 's1');
  assert.equal(compact.pack.status.timestamp, '2026-10-12T08:00:00Z');
  assert.deepEqual(compact.pack.corrections[0], full.pack.corrections[0]);
  assert.equal(compact.pack.decisions[0].approval_state, 'unknown');
  assert.equal(compact.memory_records[0].review_state, 'unknown');
  assert.equal(compact.memory_records[0].truncated, true);
  assert.deepEqual(compact.errors, full.errors);
  assert.equal(compact.tasks.active[0].description, full.tasks.active[0].description);
  assert.deepEqual(compact.tasks.active[0].notes, full.tasks.active[0].notes);
  assert.equal(compact.tasks.active[0].blocker, 'approval_missing');
  assert.deepEqual(compact.doctrine, full.doctrine);
  assert.equal('_rid' in compact.memory_records[0], false);
  assert.deepEqual(full, before, 'compact projection must not mutate the full wake response');
});

test('only exact id plus full-content duplicates disappear; same id with changed text and cross-source ids survive', () => {
  const full = make({ pack: { ...make().pack, recent: [
    { id: 's1', type: 'status', text: 'paused', source: 'feed-A', agent: 'developer', timestamp: '2026-10-12T08:00:00Z' },
    { id: 's1', type: 'status', text: 'changed content', source: 'feed-A', agent: 'developer', timestamp: '2026-10-12T08:00:00Z' },
    { id: 'm1', type: 'fact', text: 'same id across sources', source: 'feed-A', agent: 'developer', timestamp: '2026-10-12T08:07:00Z' },
    { id: 'm1', type: 'fact', text: 'same id across sources', source: 'feed-A', agent: 'developer', timestamp: '2026-10-12T08:07:00Z' },
  ] } });
  const compact = buildStartupCompactWake(full) as any;
  assert.equal(compact.pack.recent.length, 2);
  assert.equal(compact.pack.recent[0].text, 'changed content');
  assert.equal(compact.pack.recent[1].id, 'm1');
  assert.equal(compact.memory_records[0].id, 'm1', 'same source id in memory remains independently visible');
});

test('empty, missing and unconfigured sections retain explicit configured/count/error state', () => {
  const full = make({ pack: { configured: false, status: null, corrections: [], decisions: [], recent: [], count: 0 }, memory_records: [], tasks: { configured: false, active: [], counts: {} }, inbox: { configured: false, count: 0, preview: [] }, inbound: { configured: false, count: 0, sinceMarker: '', notes: [] }, errors: ['memory: store unconfigured'] });
  const compact = buildStartupCompactWake(full) as any;
  assert.equal(compact.pack.configured, false);
  assert.equal(compact.pack.status, null);
  assert.equal(compact.tasks.configured, false);
  assert.equal(compact.inbox.configured, false);
  assert.equal(compact.inbound.configured, false);
  assert.deepEqual(compact.errors, full.errors);
});

test('cross-seat task is projected by the existing immutable-reader rule before compact output', () => {
  const full = make({ tasks: { configured: true, active: [{ ...make().tasks.active[0], created_by: 'cto', detail_readers: ['cto'], description: 'PRIVATE-DETAIL', notes: ['PRIVATE-NOTE'], tags: ['PRIVATE-TAG'], title: 'PRIVATE-TITLE', artifact_uri: 'artifact://private' }], counts: { blocked: 1 } } });
  const compact = buildStartupCompactWake(full) as any;
  const task = compact.tasks.active[0];
  assert.equal(task.status, 'blocked');
  assert.equal(task.details_omitted, true);
  assert.equal(task.full_fetch_required_before_action, true);
  for (const secret of ['PRIVATE-DETAIL', 'PRIVATE-NOTE', 'PRIVATE-TAG', 'PRIVATE-TITLE']) assert.equal(JSON.stringify(task).includes(secret), false);
  assert.equal(JSON.stringify(task).includes('artifact://private'), false);
});

test('registered compact view rejects non-Developer and M365 callers before reading stores', async () => {
  let handler: ((args: Record<string, unknown>) => Promise<Record<string, unknown>>) | undefined;
  const server = { registerTool(_name: string, _config: unknown, candidate: typeof handler extends infer _ ? any : never) { handler = candidate; return { remove() {} }; } };
  const env = { CIO_SITE_ID: 'synthetic-site', CIO_TRACK_KEY: 'synthetic-track-key', CIO_APP_API_BEARER: 'synthetic-bearer', PERPLEXITY_CONNECTOR_TOKEN: 'synthetic-connector-placeholder-1234567890', ADMIN_REVOKE_TOKEN: 'synthetic-admin-placeholder-1234567890', N8N_WEBHOOK_SECRET: 'synthetic-webhook-placeholder-1234567890' };
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  try { registerWake(server as never, () => 'synthetic-hash'); }
  finally { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
  assert.ok(handler);
  const forbidden = await requestContext.run({ callerHash: 'synthetic', correlationId: 'synthetic', callerAgent: 'cto' }, () => handler!({ view: 'developer_compact' }));
  assert.match(JSON.stringify(forbidden), /authenticated Developer identity required/);
  const staticAuth = await requestContext.run({ callerHash: 'synthetic', correlationId: 'synthetic', callerAgent: 'developer', m365StaticAuth: true }, () => handler!({ view: 'developer_compact' }));
  assert.match(JSON.stringify(staticAuth), /unsupported_view/);
});

test('compact text serialization is opt-in and keeps structured data unchanged', () => {
  const value = { data: { field: 'a value', nested: { item: 1 } }, summary: 'summary' };
  const standard = buildTextContent(value, null);
  const compact = buildTextContent({ ...value, compactText: true }, null);
  assert.match(standard, /\n  "field"/);
  assert.equal(compact, '{"field":"a value","nested":{"item":1}}\n\nsummary');
  assert.deepEqual(JSON.parse(compact.split('\n\n')[0]), value.data);
});
