import assert from 'node:assert/strict';
import test from 'node:test';
import { activeBackend } from './store.js';
import { loadAgentStatePostgresConfig, loadHistoricalRepairEmbeddingsConfig, loadOpenSearchRuntimeConfig } from './runtime-config.js';

const names = [
  'STATE_BACKEND', 'PG_HOST', 'PG_PORT', 'PG_DATABASE', 'PG_USER', 'PG_PASSWORD', 'PG_SSL_VERIFY',
  'CIO_SITE_ID', 'CIO_TRACK_KEY', 'CIO_APP_API_BEARER', 'PERPLEXITY_CONNECTOR_TOKEN', 'ADMIN_REVOKE_TOKEN', 'N8N_WEBHOOK_SECRET',
] as const;

test('agent-state maintenance configuration needs only state-plane references', () => {
  const previous = new Map(names.map(name => [name, process.env[name]]));
  try {
    for (const name of names.slice(7)) delete process.env[name];
    Object.assign(process.env, {
      STATE_BACKEND: 'postgres', PG_HOST: 'database.internal', PG_PORT: '5432', PG_DATABASE: 'agentstate',
      PG_USER: 'worker', PG_PASSWORD: 'synthetic-password', PG_SSL_VERIFY: 'true',
    });
    assert.equal(activeBackend(), 'postgres');
    assert.deepEqual(loadAgentStatePostgresConfig(), {
      host: 'database.internal', port: 5432, database: 'agentstate', user: 'worker',
      password: 'synthetic-password', sslVerify: true,
    });
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
});

test('agent-state maintenance configuration rejects malformed state-plane values', () => {
  const previous = process.env.PG_PORT;
  try {
    process.env.PG_PORT = 'not-a-port';
    assert.throws(() => loadAgentStatePostgresConfig(), /agentstate_runtime_config_invalid/);
  } finally {
    if (previous === undefined) delete process.env.PG_PORT; else process.env.PG_PORT = previous;
  }
});

test('repair OpenSearch configuration needs no gateway-only integration values', () => {
  const previousEndpoint = process.env.OPENSEARCH_ENDPOINT;
  const previousRegion = process.env.OPENSEARCH_REGION;
  try {
    process.env.OPENSEARCH_ENDPOINT = 'https://search.example.invalid/';
    delete process.env.OPENSEARCH_REGION;
    assert.deepEqual(loadOpenSearchRuntimeConfig(), {
      endpoint: 'search.example.invalid',
      region: 'us-east-1',
    });
  } finally {
    if (previousEndpoint === undefined) delete process.env.OPENSEARCH_ENDPOINT; else process.env.OPENSEARCH_ENDPOINT = previousEndpoint;
    if (previousRegion === undefined) delete process.env.OPENSEARCH_REGION; else process.env.OPENSEARCH_REGION = previousRegion;
  }
});

test('historical repair accepts only the pinned OpenAI embedding provider', () => {
  const provider = process.env.EMBEDDINGS_PROVIDER;
  const key = process.env.OPENAI_API_KEY;
  try {
    process.env.EMBEDDINGS_PROVIDER = 'openai';
    process.env.OPENAI_API_KEY = 'synthetic-key';
    assert.deepEqual(loadHistoricalRepairEmbeddingsConfig(), { apiKey: 'synthetic-key', model: 'text-embedding-3-large' });
    process.env.EMBEDDINGS_PROVIDER = 'foundry';
    assert.equal(loadHistoricalRepairEmbeddingsConfig(), null);
  } finally {
    if (provider === undefined) delete process.env.EMBEDDINGS_PROVIDER; else process.env.EMBEDDINGS_PROVIDER = provider;
    if (key === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = key;
  }
});
