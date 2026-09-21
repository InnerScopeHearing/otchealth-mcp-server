import assert from 'node:assert/strict';
import test from 'node:test';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { requestContext } from '../../server/request-context.js';
import { redactCloudBrowserInputForLog, registerCloudBrowserTools, shieldCloudBrowserInput, type CloudBrowserGatewayRuntime } from './index.js';

for (const [key, value] of Object.entries({ CIO_SITE_ID: 'test', CIO_TRACK_KEY: 'test', CIO_APP_API_BEARER: 'test', PERPLEXITY_CONNECTOR_TOKEN: 'a'.repeat(32), ADMIN_REVOKE_TOKEN: 'b'.repeat(32), N8N_WEBHOOK_SECRET: 'c'.repeat(32) })) process.env[key] ??= value;

function fakeServer(): { server: McpServer; handlers: Map<string, (args: unknown) => Promise<{ structuredContent?: Record<string, unknown> }>> } {
  const handlers = new Map<string, (args: unknown) => Promise<{ structuredContent?: Record<string, unknown> }>>();
  return { server: { registerTool: (name: string, _config: unknown, handler: (args: unknown) => Promise<{ structuredContent?: Record<string, unknown> }>) => { handlers.set(name, handler); return { remove: () => handlers.delete(name) }; } } as unknown as McpServer, handlers };
}
test('gateway redaction and shield never retain nested typed text, URL, selector, or plan', () => {
  const raw = { action: { type: 'type', selector: '#password', text: 'typed-secret' }, plan: { actions: [{ type: 'navigate', url: 'https://private.example/path' }] } };
  const redacted = JSON.stringify(redactCloudBrowserInputForLog(raw)); const shield = JSON.stringify(shieldCloudBrowserInput(raw));
  for (const sensitive of ['typed-secret', 'private.example', '#password']) { assert.equal(redacted.includes(sensitive), false); assert.equal(shield.includes(sensitive), false); }
});
test('registered session start derives owner from authenticated context', async () => {
  const oldEnabled = process.env.CLOUD_BROWSER_ENABLED; const oldTable = process.env.CLOUD_BROWSER_DDB_TABLE; const oldQueue = process.env.CLOUD_BROWSER_QUEUE_URL; const oldBucket = process.env.CLOUD_BROWSER_S3_BUCKET; const oldReadOnly = process.env.READ_ONLY_MODE; const oldWrite = process.env.ENABLE_WRITE_TOOLS; process.env.CLOUD_BROWSER_ENABLED = 'true'; process.env.CLOUD_BROWSER_DDB_TABLE = 'synthetic-table'; process.env.CLOUD_BROWSER_QUEUE_URL = 'https://sqs.us-east-1.amazonaws.com/123/synthetic'; process.env.CLOUD_BROWSER_S3_BUCKET = 'synthetic-bucket'; process.env.READ_ONLY_MODE = 'false'; process.env.ENABLE_WRITE_TOOLS = 'true';
  const owners: string[] = []; const runtime = { browser: { start: async (owner: string) => { owners.push(owner); return { sessionId: 's', expiresAt: 1 }; }, execute: async () => undefined, stop: async () => undefined, savePersistentProfile: async () => undefined, snapshot: async () => ({}) }, jobs: {} as never, queue: {} as never, artifacts: {} as never } satisfies CloudBrowserGatewayRuntime;
  const { server, handlers } = fakeServer(); registerCloudBrowserTools(server, () => 'hash', runtime);
  try { await requestContext.run({ callerHash: 'hash', correlationId: 'c', callerAgent: 'cto' }, () => handlers.get('browser_cloud_session_start')!({ profile_id: 'cto-profile', max_seconds: 60, dry_run: false })); assert.deepEqual(owners, ['cto']); } finally { process.env.CLOUD_BROWSER_ENABLED = oldEnabled; process.env.CLOUD_BROWSER_DDB_TABLE = oldTable; process.env.CLOUD_BROWSER_QUEUE_URL = oldQueue; process.env.CLOUD_BROWSER_S3_BUCKET = oldBucket; process.env.READ_ONLY_MODE = oldReadOnly; process.env.ENABLE_WRITE_TOOLS = oldWrite; }
});
test('artifact get uses caller-owned job metadata and rejects an integrity mismatch', async () => {
  const old = [process.env.CLOUD_BROWSER_ENABLED, process.env.CLOUD_BROWSER_DDB_TABLE, process.env.CLOUD_BROWSER_QUEUE_URL, process.env.CLOUD_BROWSER_S3_BUCKET, process.env.READ_ONLY_MODE, process.env.ENABLE_WRITE_TOOLS]; Object.assign(process.env, { CLOUD_BROWSER_ENABLED: 'true', CLOUD_BROWSER_DDB_TABLE: 't', CLOUD_BROWSER_QUEUE_URL: 'https://sqs.us-east-1.amazonaws.com/1/q', CLOUD_BROWSER_S3_BUCKET: 'b', READ_ONLY_MODE: 'false', ENABLE_WRITE_TOOLS: 'true' });
  const artifact = { id: 'a1', storageKey: 'browser-cloud/cto/j/a1', storageVersion: 'v1', sha256: '0'.repeat(64) }; const calls: string[] = []; const runtime = { browser: {} as never, queue: {} as never, jobs: { get: async (_id: string, caller: string) => { calls.push(caller); if (caller !== 'cto') throw Object.assign(new Error('denied'), { code: 'job_owner_mismatch' }); return { artifacts: [artifact] }; } } as never, artifacts: { getVersion: async () => ({ body: Buffer.from('receipt'), contentType: 'application/json' }) } as never } satisfies CloudBrowserGatewayRuntime;
  const { server, handlers } = fakeServer(); registerCloudBrowserTools(server, () => 'hash', runtime);
  try { const denied = await requestContext.run({ callerHash: 'h', correlationId: 'c', callerAgent: 'cfo' }, () => handlers.get('browser_cloud_artifact_get')!({ job_id: 'j', artifact_id: 'a1' })); assert.equal((denied.structuredContent?.result as { error?: string }).error, 'job_owner_mismatch'); const bad = await requestContext.run({ callerHash: 'h', correlationId: 'c', callerAgent: 'cto' }, () => handlers.get('browser_cloud_artifact_get')!({ job_id: 'j', artifact_id: 'a1' })); assert.equal((bad.structuredContent?.result as { error?: string }).error, 'artifact_integrity_failed'); assert.deepEqual(calls, ['cfo', 'cto']); } finally { [process.env.CLOUD_BROWSER_ENABLED, process.env.CLOUD_BROWSER_DDB_TABLE, process.env.CLOUD_BROWSER_QUEUE_URL, process.env.CLOUD_BROWSER_S3_BUCKET, process.env.READ_ONLY_MODE, process.env.ENABLE_WRITE_TOOLS] = old; }
});
