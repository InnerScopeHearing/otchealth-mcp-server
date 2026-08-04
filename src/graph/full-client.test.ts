import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { requestContext } from '../server/request-context.js';

// Pins the fix for a real gap a Copilot review caught on PR #189: the original CFO
// mail-access-regression fix only patched graph/api-client.ts (used by graph_list_messages /
// sendEmail), but graph_message_get is wired to THIS file (graph/full-client.ts), a deliberately
// separate, self-contained module -- so graph_message_get would have stayed CS-only for
// matthew@innd.com even after that fix merged. These tests mirror api-client.test.ts exactly,
// against this file's own (duplicated, not imported, per its "self-contained" design) copy of the
// exec-mailbox allowlist + gating.

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

test('full-client execAllowedMailboxes: matches api-client.ts default exactly (kept in sync)', async () => {
  const full = await import('./full-client.js');
  const api = await import('./api-client.js');
  assert.deepEqual([...full.execAllowedMailboxes()].sort(), [...api.execAllowedMailboxes()].sort());
});

test('full-client isExecMailboxRequest: true for an EXEC_RING caller on a listed exec mailbox', async () => {
  const { isExecMailboxRequest } = await import('./full-client.js');
  for (const lane of ['cfo', 'clo', 'cpo', 'cco', 'exec']) {
    assert.equal(asCaller(lane, () => isExecMailboxRequest('matthew@innd.com')), true, `${lane} should reach matthew@innd.com`);
  }
});

test('full-client isExecMailboxRequest: false for a non-EXEC_RING caller or an unlisted mailbox', async () => {
  const { isExecMailboxRequest } = await import('./full-client.js');
  assert.equal(asCaller('cto', () => isExecMailboxRequest('matthew@innd.com')), false);
  assert.equal(asCaller('developer', () => isExecMailboxRequest('matthew@innd.com')), false);
  assert.equal(asCaller('cfo', () => isExecMailboxRequest('care@otchealthmart.com')), false);
});

test('registered graph_message_get tool threads mailbox through to getMessage (the exact regression Copilot caught)', async () => {
  // Static check, not a network call: message-get.ts must pass input.mailbox as getMessage's
  // SECOND argument (full-client.ts's getMessage(messageId, mailbox?) -- note this is a
  // different argument order than api-client.ts's getMessage(mailbox, messageId)). A future
  // refactor that drops this silently strands every exec-mailbox call back on the sender default.
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../tools/graph/message-get.ts', import.meta.url), 'utf8');
  assert.match(src, /getMessage\(input\.message_id,\s*input\.mailbox\)/, 'message-get.ts handler must call getMessage(input.message_id, input.mailbox)');
  assert.match(src, /from '\.\.\/\.\.\/graph\/full-client\.js'/, 'message-get.ts must still import getMessage from full-client.js');
});
