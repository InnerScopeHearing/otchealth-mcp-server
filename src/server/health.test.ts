import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

// Set required env vars before importing the module (loadEnv runs at import time).
before(() => {
  const required: Record<string, string> = {
    CIO_SITE_ID: 'test',
    CIO_TRACK_KEY: 'test',
    CIO_APP_API_BEARER: 'test',
    PERPLEXITY_CONNECTOR_TOKEN: 'a'.repeat(32),
    ADMIN_REVOKE_TOKEN: 'b'.repeat(32),
    N8N_WEBHOOK_SECRET: 'c'.repeat(32),
    HEYGEN_OWNER_APPROVAL_SUBJECT: 'synthetic-owner@example.invalid',
    HEYGEN_APPROVAL_CONTEXT_SECRET: 'synthetic-context-approval-secret-0001',
    HEYGEN_APPROVAL_HANDLE_SECRET: 'synthetic-handle-approval-secret-0002',
    HEYGEN_APPROVAL_CALLBACK_SECRET: 'synthetic-callback-approval-secret-0003',
    NODE_ENV: 'test',
    REVOCATION_MEMORY_ONLY_MODE: 'development',
  };
  // This test file owns its child-process configuration; never inherit real credentials or
  // approval settings from the invoking environment.
  for (const [k, v] of Object.entries(required)) process.env[k] = v;
  for (const name of ['HEYGEN_OWNER_APPROVAL_PUBLIC_JWK', 'HEYGEN_APPROVAL_BROKER_URL',
    'HEYGEN_OWNER_APPROVAL_ISSUER', 'HEYGEN_OWNER_APPROVAL_AUDIENCE']) delete process.env[name];
  for (const name of ['ENABLE_HEYGEN_PROVIDER_WRITES', 'ENABLE_HEYGEN_PROMPT_AVATAR_WRITES',
    'ENABLE_HEYGEN_AVATAR_VIDEO_WRITES', 'ENABLE_HEYGEN_REFERENCE_LOOK_WRITES',
    'ENABLE_HEYGEN_VIDEO_AGENT_CHAT_WRITES', 'ENABLE_HEYGEN_VIDEO_AGENT_GENERATION',
    'ENABLE_HEYGEN_ASSET_WRITES', 'ENABLE_HEYGEN_TRANSLATION_WRITES',
    'ENABLE_HEYGEN_TTS_WRITES', 'ENABLE_HEYGEN_METADATA_WRITES']) process.env[name] = 'false';
});

test('buildHealthPayload returns expected shape with status ok', async () => {
  const { buildHealthPayload } = await import('./health.js');
  const payload = buildHealthPayload();

  assert.equal(payload.status, 'ok');
  assert.equal(payload.liveness, 'ok');
  assert.equal(payload.readiness, 'ready');
  assert.equal(payload.service, 'otchealth-mcp-server');
  assert.equal(typeof payload.time, 'string');
  assert.ok('env' in payload);
  assert.ok('read_only_mode' in payload);
  assert.ok('connector_token_revoked' in payload);
  assert.deepEqual(payload.heygen, {
    provider_writes: false,
    prompt_avatar_writes: false,
    avatar_video_writes: false,
    reference_look_writes: false,
    video_agent_chat_writes: false,
    video_agent_generation: false,
    asset_writes: false,
    translation_writes: false,
    tts_writes: false,
    metadata_writes: false,
    cro_direct_enabled: true,
    cro_direct_tools: [
      'heygen_avatar_video_create',
      'heygen_existing_video_ingest_qa',
      'heygen_video_wait_ingest_qa',
    ],
    owner_approval_verifier_configured: false,
    owner_approval_context_configured: true,
    owner_approval_handle_configured: true,
    owner_approval_callback_configured: true,
    owner_approval_broker_configured: false,
    owner_approval_issuer: 'https://approval.otchealth.app',
    owner_approval_audience: 'otchealth-heygen',
    owner_approval_compatibility: {
      public_jwk_sha256: undefined,
    },
  });
  const serialized = JSON.stringify(payload);
  for (const name of ['HEYGEN_OWNER_APPROVAL_SUBJECT', 'HEYGEN_APPROVAL_CONTEXT_SECRET', 'HEYGEN_APPROVAL_HANDLE_SECRET', 'HEYGEN_APPROVAL_CALLBACK_SECRET']) {
    const secret = process.env[name]!;
    assert.ok(!serialized.includes(secret));
    assert.ok(!serialized.includes(createHash('sha256').update(secret, 'utf8').digest('hex')));
  }
});

test('buildHealthPayload reports degraded readiness while preserving liveness', async () => {
  const { buildHealthPayload } = await import('./health.js');
  const payload = buildHealthPayload({
    persistence_configured: false,
    persistence_required: true,
    static_token_auth_ready: false,
    state: 'unavailable',
    last_successful_load_at: null,
    last_failed_load_at: '2026-09-07T00:00:00.000Z',
    last_failed_persist_at: null,
    stale_for_ms: null,
    max_stale_ms: 300_000,
  });
  assert.equal(payload.status, 'degraded');
  assert.equal(payload.liveness, 'ok');
  assert.equal(payload.readiness, 'not_ready');
});

test('/health stays live while /health/ready returns 503 for unavailable static auth', async () => {
  const { default: Fastify } = await import('fastify');
  const { registerHealth } = await import('./health.js');
  const app = Fastify();
  registerHealth(app, () => ({
    persistence_configured: false,
    persistence_required: true,
    static_token_auth_ready: false,
    state: 'unavailable',
    last_successful_load_at: null,
    last_failed_load_at: '2026-09-07T00:00:00.000Z',
    last_failed_persist_at: null,
    stale_for_ms: null,
    max_stale_ms: 300_000,
  }));
  const live = await app.inject({ method: 'GET', url: '/health' });
  const ready = await app.inject({ method: 'GET', url: '/health/ready' });
  assert.equal(live.statusCode, 200);
  assert.equal(live.json().status, 'degraded');
  assert.equal(ready.statusCode, 503);
  assert.equal(ready.json().status, 'not_ready');
  await app.close();
});

test('/health/deep includes only its same-process revision receipt after admin authentication', async () => {
  const { default: Fastify } = await import('fastify');
  const { registerHealth } = await import('./health.js');
  const app = Fastify();
  registerHealth(app);

  const previousMetadataUri = process.env.ECS_CONTAINER_METADATA_URI_V4;
  const previousFetch = globalThis.fetch;
  let metadataReads = 0;
  process.env.ECS_CONTAINER_METADATA_URI_V4 = 'http://metadata.test';
  globalThis.fetch = (async () => {
    metadataReads += 1;
    return new Response(JSON.stringify({
      Image: 'registry.example/otchealth-gateway:merge123',
      ImageID: `sha256:${'d'.repeat(64)}`,
      Labels: {
        'com.amazonaws.ecs.task-definition-family': 'otchealth-gateway',
        'com.amazonaws.ecs.task-definition-version': '201',
      },
    }), { status: 200 });
  }) as typeof fetch;

  try {
    const unauthorized = await app.inject({ method: 'GET', url: '/health/deep' });
    assert.equal(unauthorized.statusCode, 401);
    const intercomUnauthorized = await app.inject({ method: 'GET', url: '/health/intercom' });
    assert.equal(intercomUnauthorized.statusCode, 401);
    assert.equal(metadataReads, 0, 'unauthorized request must not read task metadata');

    const authorized = await app.inject({
      method: 'GET',
      url: '/health/deep',
      headers: { authorization: `Bearer ${process.env.ADMIN_REVOKE_TOKEN}` },
    });
    assert.equal(authorized.statusCode, 200);
    assert.deepEqual(authorized.json().revision, {
      image_tag: 'merge123',
      image_digest: `sha256:${'d'.repeat(64)}`,
      task_definition: 'otchealth-gateway:201',
    });
    assert.equal(metadataReads, 1);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousMetadataUri === undefined) delete process.env.ECS_CONTAINER_METADATA_URI_V4;
    else process.env.ECS_CONTAINER_METADATA_URI_V4 = previousMetadataUri;
    await app.close();
  }
});
