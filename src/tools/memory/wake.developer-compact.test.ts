import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDeveloperCompactWake,
  filterSupersededWakeData,
  registerWake,
  type WakeFullData,
} from './wake.js';
import { requestContext } from '../../server/request-context.js';

const long = (size: number, tail = 'END-OF-OPERATIVE-TEXT') => `${'x'.repeat(size)}${tail}`;

function fixture(overrides: Partial<WakeFullData> = {}): WakeFullData {
  return {
    agent: 'developer',
    pack: {
      configured: true,
      status: { id: 'status-1', type: 'status', text: 'working', source: 'shared', agent: 'developer' },
      corrections: [{ id: 'correction-1', type: 'correction', text: long(1200), source: 'shared', supersedes: 'old-1', agent: 'developer' }],
      decisions: [{ id: 'decision-1', type: 'decision', text: 'operative decision', source: 'shared', agent: 'developer' }],
      recent: [
        { id: 'status-1', type: 'status', text: 'duplicate status' },
        { id: 'correction-1', type: 'correction', text: 'duplicate correction' },
        { id: 'recent-1', type: 'fact', text: long(1100), source: 'shared', agent: 'developer' },
        { id: 'recent-2', type: 'fact', text: 'same content, different id', agent: 'developer' },
      ],
      count: 9,
    },
    memory_records: [{ id: 'memory-1', kind: 'fact', text: long(1300), source: 'cosmos', agent: 'developer', date: '2026-10-11', timestamp: '2026-10-12T00:00:00Z', created_at: '2026-10-12', supersedes: 'memory-old', truncated: true, _text_truncated: true, tags: ['omit'] }],
    tasks: {
      configured: true,
      active: [
        { id: 'task-1', board: 'developer', type: 'task', owner_agent: 'developer', status: 'blocked', priority: 'high', title: 'Visible title', artifact_uri: 'artifact://visible', blocker: 'task-0', description: 'omit me', notes: ['omit me'], created_at: 'today', created_by: 'developer', detail_readers: ['developer'] },
        { id: 'task-owner-reassigned', board: 'developer', type: 'task', owner_agent: 'developer', status: 'open', priority: 'normal', title: 'MUST NOT LEAK', artifact_uri: 'artifact://must-not-leak', blocker: 'MUST NOT LEAK', dependencies: ['MUST NOT LEAK'], description: 'MUST NOT LEAK', notes: ['MUST NOT LEAK'], created_at: 'today', created_by: 'cfo', detail_readers: ['cfo'] },
      ],
      counts: { blocked: 1 },
    },
    inbox: { configured: true, count: 1, preview: [{ message_id: 'message-1', from: 'cto', subject: 'subject', body: long(600), ts: 'today' }] },
    inbound: { configured: true, count: 1, sinceMarker: 'marker', notes: [{ id: 'inbound-1', text: long(1000), by: 'cto', source: 'shared' }] },
    errors: ['tasks: synthetic read failure'],
    doctrine: {
      definition_of_done: 'complete and verified',
      pitfalls: [{ id: 'pitfall-1', text: 'existing selected pitfall', source: 'shared_feed' }],
      standing_directives: ['standing directive 1', 'standing directive 2'],
    },
    ...overrides,
  };
}

test('developer compact preserves complete operative text and provenance while removing only exact duplicate recent IDs', () => {
  const result = buildDeveloperCompactWake(fixture()) as any;
  assert.equal(result.view, 'developer_compact');
  assert.equal(result.pack.corrections[0].text, long(1200));
  assert.equal(result.pack.corrections[0].source, 'shared');
  assert.equal(result.pack.corrections[0].supersedes, 'old-1');
  assert.equal(result.pack.decisions[0].text, 'operative decision');
  assert.deepEqual(result.pack.recent.map((rec: any) => rec.id), ['recent-1', 'recent-2']);
  assert.equal(result.pack.recent[0].text, long(1100));
});

test('developer compact projects memory and task metadata, preserves full message bodies, counts, errors, and doctrine', () => {
  const full = fixture();
  const result = buildDeveloperCompactWake(full) as any;
  assert.deepEqual(result.memory_records[0], {
    id: 'memory-1', kind: 'fact', text: long(1300), source: 'cosmos', agent: 'developer', date: '2026-10-11', timestamp: '2026-10-12T00:00:00Z', created_at: '2026-10-12', supersedes: 'memory-old', truncated: true, _text_truncated: true,
  });
  assert.equal(result.tasks.active[0].title, 'Visible title');
  assert.equal(result.tasks.active[0].artifact_uri, 'artifact://visible');
  assert.equal(result.tasks.active[0].blocker, 'task-0');
  assert.equal(result.tasks.active[0].details_omitted, true);
  assert.equal(result.tasks.active[0].full_fetch_required_before_action, true);
  assert.equal('description' in result.tasks.active[0], false);
  assert.equal('notes' in result.tasks.active[0], false);
  const hidden = result.tasks.active[1];
  assert.equal(hidden.owner_agent, 'developer');
  assert.equal(hidden.status, 'open');
  assert.equal(hidden.details_omitted, true);
  assert.equal(hidden.full_fetch_required_before_action, true);
  for (const field of ['title', 'artifact_uri', 'blocker', 'dependencies', 'description', 'notes', 'created_by', 'detail_readers']) {
    assert.equal(Object.hasOwn(hidden, field), false, `unauthorized task field ${field} leaked`);
  }
  assert.equal(result.inbox.preview[0].body, long(600));
  assert.equal(result.inbound.notes[0].text, long(1000));
  assert.equal(result.pack.count, full.pack.count);
  assert.equal(result.inbox.count, full.inbox.count);
  assert.equal(result.inbound.count, full.inbound.count);
  assert.deepEqual(result.errors, full.errors);
  assert.deepEqual(result.doctrine, full.doctrine);
});

test('developer compact honors an external retraction set across sections before projection', () => {
  const full = fixture({
    pack: {
      configured: true,
      status: { id: 'ret-status', type: 'status', text: 'old status', agent: 'developer' },
      corrections: [{ id: 'ret-correction', type: 'correction', text: 'old correction', agent: 'developer' }],
      decisions: [], recent: [{ id: 'ret-recent', type: 'fact', text: 'old fact', agent: 'developer' }], count: 3,
    },
    memory_records: [{ id: 'ret-memory', kind: 'fact', text: 'old memory' }],
    inbound: { configured: true, count: 1, sinceMarker: '', notes: [{ id: 'ret-inbound', text: 'old inbound', agent: 'developer' }] },
  });
  const current = filterSupersededWakeData(full, [], new Set(['ret-status', 'ret-correction', 'ret-recent', 'ret-memory', 'ret-inbound']));
  const compact = buildDeveloperCompactWake(current) as any;
  assert.equal(compact.pack.status, null);
  assert.deepEqual(compact.pack.corrections, []);
  assert.deepEqual(compact.pack.recent, []);
  assert.deepEqual(compact.memory_records, []);
  assert.deepEqual(compact.inbound.notes, []);
  assert.equal(compact.pack.count, 3);
  assert.equal(compact.inbound.count, 1);
});

type RegisteredHandler = (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
function captureHandler(): RegisteredHandler {
  let handler: RegisteredHandler | undefined;
  const server = { registerTool(_name: string, _config: unknown, candidate: RegisteredHandler) { handler = candidate; return { remove() {} }; } };
  const env = {
    CIO_SITE_ID: 'synthetic-site', CIO_TRACK_KEY: 'synthetic-track-key', CIO_APP_API_BEARER: 'synthetic-bearer',
    PERPLEXITY_CONNECTOR_TOKEN: 'synthetic-connector-placeholder-1234567890',
    ADMIN_REVOKE_TOKEN: 'synthetic-admin-placeholder-1234567890', N8N_WEBHOOK_SECRET: 'synthetic-webhook-placeholder-1234567890',
  };
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  try {
    registerWake(server as never, () => 'synthetic-hash');
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  assert.ok(handler);
  return handler;
}

test('registered wake refuses compact mode for non-Developer callers and personal-legal scope before the store-backed path', async () => {
  const handler = captureHandler();
  const nonDeveloper = await requestContext.run(
    { callerHash: 'synthetic', correlationId: 'synthetic', callerAgent: 'cto' },
    () => handler({ view: 'developer_compact' }),
  );
  assert.match(JSON.stringify(nonDeveloper), /authenticated Developer identity required/);

  const personal = await requestContext.run(
    { callerHash: 'synthetic', correlationId: 'synthetic', callerAgent: 'developer' },
    () => handler({ view: 'developer_compact', agent: 'clo-personal' }),
  );
  assert.match(JSON.stringify(personal), /forbidden_agent/);
});

test('registered wake rejects compact mode for M365 static auth and default mode retains its old output shape', async () => {
  const handler = captureHandler();
  const m365 = await requestContext.run(
    { callerHash: 'synthetic', correlationId: 'synthetic', callerAgent: 'developer', m365StaticAuth: true },
    () => handler({ view: 'developer_compact' }),
  );
  assert.match(JSON.stringify(m365), /unsupported_view/);

  const defaultDenied = await requestContext.run(
    { callerHash: 'synthetic', correlationId: 'synthetic', callerAgent: 'developer' },
    () => handler({ agent: 'cto' }),
  );
  const data = (defaultDenied as any).structuredContent?.result ?? (defaultDenied as any).data;
  assert.ok(data);
  assert.equal(Object.hasOwn(data, 'view'), false);
  assert.match(JSON.stringify(defaultDenied), /authenticated callers can load only their own agent context/);
});
