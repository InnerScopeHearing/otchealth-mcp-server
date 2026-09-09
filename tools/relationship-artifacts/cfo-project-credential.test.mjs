import test from 'node:test';
import assert from 'node:assert/strict';
import { createCfoProjectBearerTokenProvider } from './cfo-project-credential.mjs';

const path = (await import('node:path')).resolve('synthetic','CFO','.codex','config.toml');
const token = 'synthetic-cfo-token-value-123456';
const reader = value => ({
  statImpl: async () => ({ isFile: () => true, size: Buffer.byteLength(value) }),
  readFileImpl: async () => value,
});

test('refresh observes rotation and never falls back after removal or read failure', async () => {
  let value = `[mcp_servers.otchealth.http_headers]\nAuthorization = "Bearer ${token}"\n`;
  let unavailable = false;
  const provider = createCfoProjectBearerTokenProvider({configPath:path,
    statImpl:async()=>({isFile:()=>true,size:Buffer.byteLength(value)}),
    readFileImpl:async()=>{if(unavailable)throw Error('unavailable');return value;}});
  assert.equal(await provider(), token);
  const rotated = 'synthetic-rotated-token-value-56789';
  value = value.replace(token, rotated);
  assert.equal(await provider(), rotated);
  unavailable = true;
  await assert.rejects(provider(), /unavailable/);
  unavailable = false;
  value = '[mcp_servers.otchealth]\n';
  await assert.rejects(provider(), /missing/);
});

test('cancelled credential lookup does not read the configuration', async () => {
  const controller = new AbortController();controller.abort();let reads = 0;
  const provider = createCfoProjectBearerTokenProvider({configPath:path,
    statImpl:async()=>{reads++;return {};},readFileImpl:async()=>{reads++;return '';}});
  await assert.rejects(provider({}, {signal:controller.signal}), {name:'AbortError'});
  assert.equal(reads, 0);
});

test('reads one designated CFO bearer only into the returned closure', async () => {
  const config = `[mcp_servers.otchealth.http_headers]\nAuthorization = "Bearer ${token}"\n`;
  const provider = createCfoProjectBearerTokenProvider({ configPath: path, ...reader(config) });
  assert.equal(await provider(), token);
  assert.equal(await provider(), token);
});

test('accepts the existing inline header form', async () => {
  const config = `[mcp_servers.otchealth]\nhttp_headers = { Authorization = "Bearer ${token}" }\n`;
  assert.equal(await createCfoProjectBearerTokenProvider({ configPath: path, ...reader(config) })(), token);
});

test('rejects arbitrary locations, duplicate headers, and escaped values', async () => {
  assert.throws(() => createCfoProjectBearerTokenProvider({ configPath: 'C:\\Workspace\\CTO\\.codex\\config.toml', ...reader('') }), /configuration/);
  const duplicate = `[mcp_servers.otchealth.http_headers]\nAuthorization = "Bearer ${token}"\nAuthorization = "Bearer ${token}"\n`;
  await assert.rejects(createCfoProjectBearerTokenProvider({ configPath: path, ...reader(duplicate) })(), /missing/);
  const escaped = `[mcp_servers.otchealth.http_headers]\nAuthorization = "Bearer ${token}\\n"\n`;
  await assert.rejects(createCfoProjectBearerTokenProvider({ configPath: path, ...reader(escaped) })(), /missing/);
});

test('rejects inline authorization from a different server section', async () => {
 const config=`[mcp_servers.other]\nhttp_headers = { Authorization = "Bearer ${token}" }\n`;
 await assert.rejects(createCfoProjectBearerTokenProvider({configPath:path,...reader(config)})(), /missing/);
});

test('does not mix another server inline header with the CFO otchealth bearer', async () => {
 const config=`[mcp_servers.other]\nhttp_headers = { Authorization = "Bearer synthetic-other-not-used-1234" }\n[mcp_servers.otchealth]\nhttp_headers = { Authorization = "Bearer ${token}" }\n`;
 assert.equal(await createCfoProjectBearerTokenProvider({configPath:path,...reader(config)})(),token);
});
