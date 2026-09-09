import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryRememberSharedWriteRefusal, registerMemoryRemember } from './remember.js';
import { requestContext } from '../../server/request-context.js';

type RegisteredHandler = (args: Record<string, unknown>) => Promise<Record<string, unknown>>;

const syntheticEnvironment: Record<string, string> = {
  CIO_SITE_ID: 'synthetic-site',
  CIO_TRACK_KEY: 'synthetic-track-key',
  CIO_APP_API_BEARER: 'synthetic-bearer-placeholder',
  PERPLEXITY_CONNECTOR_TOKEN: 'synthetic-connector-placeholder-1234567890',
  ADMIN_REVOKE_TOKEN: 'synthetic-admin-placeholder-1234567890',
  N8N_WEBHOOK_SECRET: 'synthetic-webhook-placeholder-1234567890',
  READ_ONLY_MODE: 'false',
  ENABLE_WRITE_TOOLS: 'true',
  DRY_RUN_DEFAULT: 'true',
};
const priorEnvironment = Object.fromEntries(Object.keys(syntheticEnvironment).map((key) => [key, process.env[key]]));

before(() => Object.assign(process.env, syntheticEnvironment));
after(() => {
  for (const [key, value] of Object.entries(priorEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function captureHandler(): RegisteredHandler {
  let handler: RegisteredHandler | undefined;
  const server = {
    registerTool(_name: string, _config: unknown, candidate: RegisteredHandler) {
      handler = candidate;
      return { remove() {} };
    },
  };
  registerMemoryRemember(server as never, () => 'synthetic-caller-hash');
  assert.ok(handler);
  return handler;
}

async function callRemember(callerAgent: string, targetAgent?: string) {
  const handler = captureHandler();
  return requestContext.run(
    { callerHash: 'synthetic-caller-hash', correlationId: 'synthetic-correlation', callerAgent },
    () => handler({
      ...(targetAgent === undefined ? {} : { agent: targetAgent }),
      type: 'fact',
      text: 'synthetic boundary probe',
      dry_run: true,
    }),
  );
}

test('ordinary company self and cross-lane writes clear the shared-feed fence', () => {
  assert.equal(memoryRememberSharedWriteRefusal('cto'), null);
  assert.equal(memoryRememberSharedWriteRefusal('cto', 'developer'), null);
  assert.equal(memoryRememberSharedWriteRefusal('developer', 'cto'), null);
});

test('registered handler preserves an ordinary attributed cross-lane dry-run preview', async () => {
  const response = await callRemember('cto', 'developer');
  const result = (response.structuredContent as Record<string, unknown>).result as Record<string, unknown>;
  assert.equal(result.written, false);
  const entry = result.entry as Record<string, unknown>;
  assert.equal(entry.agent, 'developer');
  assert.equal(entry.by, 'cto');
  assert.match(String(result.note), /dry_run/);
});

test('personal-lane authenticated writers are refused for self and company targets', () => {
  assert.match(memoryRememberSharedWriteRefusal('clo-personal') ?? '', /privilege-walled personal-legal lane/);
  assert.match(memoryRememberSharedWriteRefusal(' CLO-PERSONAL ', 'cto') ?? '', /company shared-memory feed/);
});

test('personal-lane targets are refused for company and caller-less writers', () => {
  assert.match(memoryRememberSharedWriteRefusal('cto', 'clo-personal') ?? '', /privilege-walled personal-legal lane/);
  assert.match(memoryRememberSharedWriteRefusal('', ' CLO-PERSONAL ') ?? '', /company shared-memory feed/);
});

test('malformed targets retain the existing normalization refusal', () => {
  assert.throws(() => memoryRememberSharedWriteRefusal('cto', '../synthetic'), /invalid agent/);
});

test('registered handler refuses a personal-lane caller before shared storage or indexing', async () => {
  const response = await callRemember('clo-personal', 'cto');
  const result = (response.structuredContent as Record<string, unknown>).result as Record<string, unknown>;
  assert.equal(result.written, false);
  assert.equal(result.entry, null);
  assert.match(String(result.note), /privilege-walled personal-legal lane/);
});

test('registered handler refuses a personal-lane target before shared storage or indexing', async () => {
  const response = await callRemember('cto', 'clo-personal');
  const result = (response.structuredContent as Record<string, unknown>).result as Record<string, unknown>;
  assert.equal(result.written, false);
  assert.equal(result.entry, null);
  assert.match(String(result.note), /company shared-memory feed/);
});