import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { requestContext } from '../server/request-context.js';

// Pins the 2026-08-04 CFO FY2021-close regression fix: graph_list_messages/graph_message_get
// resolve mailboxes on GRAPH_EXEC_MAILBOXES through a SEPARATE, non-CS-restricted app for
// EXEC_RING callers only. The CS allowlist/app/policy is completely unaffected by this -- these
// tests exist to make sure a future edit can't silently widen the exec path to a non-exec lane or
// an unlisted mailbox, or narrow it back to nothing.

before(() => {
  process.env.CIO_SITE_ID ??= 'test';
  process.env.CIO_TRACK_KEY ??= 'test';
  process.env.CIO_APP_API_BEARER ??= 'test';
  process.env.PERPLEXITY_CONNECTOR_TOKEN ??= 'a'.repeat(32);
  process.env.ADMIN_REVOKE_TOKEN ??= 'b'.repeat(32);
  process.env.N8N_WEBHOOK_SECRET ??= 'c'.repeat(32);
});

function asCaller<T>(callerAgent: string, fn: () => T): T {
  return requestContext.run(
    { callerHash: 'test', correlationId: 'test', callerAgent },
    fn,
  );
}

test('execAllowedMailboxes: defaults to the 4 named exec mailboxes from the CFO request', async () => {
  const { execAllowedMailboxes } = await import('./api-client.js');
  const set = execAllowedMailboxes();
  assert.ok(set.has('matthew@innd.com'));
  assert.ok(set.has('ap@innd.com'));
  assert.ok(set.has('accounting@hearingassist.com'));
  assert.ok(set.has('cfo@innd.com'));
  // Never defaults to a CS mailbox -- the two allowlists must stay disjoint in intent.
  assert.equal(set.has('care@otchealthmart.com'), false);
});

test('isExecMailboxRequest: true for an EXEC_RING caller asking for a listed exec mailbox', async () => {
  const { isExecMailboxRequest } = await import('./api-client.js');
  for (const lane of ['cfo', 'clo', 'cpo', 'cco', 'exec']) {
    assert.equal(asCaller(lane, () => isExecMailboxRequest('matthew@innd.com')), true, `${lane} should reach matthew@innd.com`);
    assert.equal(asCaller(lane, () => isExecMailboxRequest('MATTHEW@INND.COM')), true, 'case-insensitive');
  }
});

test('isExecMailboxRequest: false for a non-EXEC_RING caller, even on a listed mailbox', async () => {
  const { isExecMailboxRequest } = await import('./api-client.js');
  for (const lane of ['cto', 'developer', 'cro', 'coo', '', 'randostring']) {
    assert.equal(asCaller(lane, () => isExecMailboxRequest('matthew@innd.com')), false, `${lane} must NOT get the exec mail path`);
  }
});

test('isExecMailboxRequest: false for an EXEC_RING caller on a mailbox NOT on the exec list (incl. CS mailboxes)', async () => {
  const { isExecMailboxRequest } = await import('./api-client.js');
  assert.equal(asCaller('cfo', () => isExecMailboxRequest('care@otchealthmart.com')), false);
  assert.equal(asCaller('cfo', () => isExecMailboxRequest('ceo@innd.com')), false);
  assert.equal(asCaller('clo', () => isExecMailboxRequest('someone-else@innd.com')), false);
});
