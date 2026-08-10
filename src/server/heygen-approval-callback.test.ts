import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { registerHeyGenApprovalCallback } from './heygen-approval-callback.js';
import type { HeyGenApprovalStoreDeps } from '../tools/heygen/approval-store.js';

function requiredEnv(): void {
  process.env.CIO_SITE_ID ??= 'test';
  process.env.CIO_TRACK_KEY ??= 'test';
  process.env.CIO_APP_API_BEARER ??= 'test';
  process.env.PERPLEXITY_CONNECTOR_TOKEN ??= 'x'.repeat(32);
  process.env.ADMIN_REVOKE_TOKEN ??= 'x'.repeat(32);
  process.env.N8N_WEBHOOK_SECRET ??= 'x'.repeat(32);
  process.env.HEYGEN_APPROVAL_CALLBACK_SECRET = 'callback-secret-with-at-least-thirty-two-bytes';
}

test('gateway approval callback authenticates the broker and stores only encrypted handle evidence', async () => {
  requiredEnv();
  let stored: Record<string, unknown> | null = null;
  const deps: HeyGenApprovalStoreDeps = {
    now: () => 1_800_000_000_000,
    create: (async (_coll, _pk, doc) => { stored = doc; return { ok: true, status: 201, body: doc, etag: 'E1' }; }) as HeyGenApprovalStoreDeps['create'],
    read: (async () => null) as HeyGenApprovalStoreDeps['read'],
  };
  const app = Fastify({ logger: false });
  registerHeyGenApprovalCallback(app, deps);
  const payload = {
    operation_id: 'video_op_01', packet_sha256: 'a'.repeat(64), owner_approval_handle: 'h'.repeat(120),
    owner_subject: 'matthew@otchealthmart.com', expires_at: new Date(1_800_000_300_000).toISOString(),
  };
  const denied = await app.inject({ method: 'POST', url: '/heygen/approval/callback', payload });
  assert.equal(denied.statusCode, 401, denied.body);
  const accepted = await app.inject({ method: 'POST', url: '/heygen/approval/callback', headers: {
    'x-heygen-approval-callback-secret': process.env.HEYGEN_APPROVAL_CALLBACK_SECRET,
  }, payload });
  assert.equal(accepted.statusCode, 201);
  assert.ok(stored);
  const serialized = JSON.stringify(stored);
  assert.ok(!serialized.includes('matthew@otchealthmart.com'));
  assert.ok(!serialized.includes('owner_approval_jws'));
  await app.close();
});
