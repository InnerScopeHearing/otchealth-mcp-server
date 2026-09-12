#!/usr/bin/env node
/** Metadata-only production preflight for the source-owned CFO identity registry. */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCfoProjectBearerTokenProvider } from './relationship-artifacts/cfo-project-credential.mjs';

const SHA256 = /^[a-f0-9]{64}$/;
const MAX_READINESS_BYTES = 16 * 1024;
const OUTPUT_KEYS = ['configured', 'valid_config', 'storage_policy_ready', 'coverage_ready', 'reason'];
const READINESS_REASONS = new Set([
  'not_configured', 'resolver_unavailable', 'registry_not_configured', 'invalid_config',
  'storage_policy_not_verified', 'run_mismatch', 'coverage_unavailable',
  'coverage_not_checked', 'coverage_checked', 'coverage_missing',
]);
export const APPROVED_GATEWAY_ORIGIN = 'https://mcp.otchealth.app';

function result(status, code, extra = {}) {
  const inputError = new Set(['invalid_arguments', 'config_unreadable', 'private_key_material_rejected', 'config_invalid', 'config_absent', 'compiled_config_validator_unavailable', 'invalid_source_binding_sha256', 'cfo_bearer_token_unavailable']);
  return { exitCode: status === 'ready' || status === 'config_valid' ? 0 : inputError.has(code) ? 2 : 1,
    payload: { schema: 'identity-registry-production-preflight-v1', status, ...(code ? { code } : {}), ...extra } };
}

function metadataReadiness(value) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype ||
      Object.keys(value).sort().join('\0') !== [...OUTPUT_KEYS].sort().join('\0')) return null;
  if (!(typeof value.configured === 'boolean' || value.configured === null) ||
      !(typeof value.valid_config === 'boolean' || value.valid_config === null) ||
      !(typeof value.storage_policy_ready === 'boolean' || value.storage_policy_ready === null) ||
      typeof value.coverage_ready !== 'boolean' || typeof value.reason !== 'string' ||
      !READINESS_REASONS.has(value.reason)) return null;
  return Object.fromEntries(OUTPUT_KEYS.map(key => [key, value[key]]));
}

async function boundedReadinessJson(response) {
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_READINESS_BYTES)) return null;
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_READINESS_BYTES) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(part.value);
    }
  } catch { return null; }
  finally { reader.releaseLock(); }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks.map(value => Buffer.from(value)), size))); }
  catch { return null; }
}

/** Test seam only. The command-line path uses global fetch and the fixed origin. */
export async function runIdentityRegistryProductionPreflight({ configPath, checkLive = false, sourceBindingSha256, cfoProjectConfig, credentialProvider, token = process.env.GRAPH_IDENTITY_REGISTRY_CFO_BEARER_TOKEN, fetchImpl = globalThis.fetch } = {}) {
  if (typeof configPath !== 'string' || !configPath || (checkLive && !sourceBindingSha256) || (!checkLive && sourceBindingSha256)) return result('blocked', 'invalid_arguments');
  if (checkLive && !SHA256.test(sourceBindingSha256)) return result('blocked', 'invalid_source_binding_sha256');
  let raw;
  try { raw = await readFile(resolve(configPath), 'utf8'); } catch { return result('blocked', 'config_unreadable'); }
  if (/-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----/.test(raw)) return result('blocked', 'private_key_material_rejected');
  let parse;
  try { ({ parseIdentityRegistryProductionConfig: parse } = await import('../dist/server/identity-registry-production-config.js')); }
  catch { return result('blocked', 'compiled_config_validator_unavailable'); }
  let config;
  try { config = parse(raw); } catch { return result('blocked', 'config_invalid'); }
  if (!config) return result('blocked', 'config_absent');
  const receipt = { config_valid: true, registry_config_sha256: createHash('sha256').update(raw).digest('hex'), live_probe: false };
  if (!checkLive) return result('config_valid', undefined, receipt);
  let bearer = token;
  if (credentialProvider || cfoProjectConfig) {
    const provider = credentialProvider ?? createCfoProjectBearerTokenProvider({ configPath: cfoProjectConfig });
    try { bearer = await provider({ purpose: 'identity_registry_readiness' }, { signal: AbortSignal.timeout(10_000) }); }
    catch { return result('blocked', 'cfo_project_credential_unavailable'); }
  }
  if (!bearer) return result('blocked', 'cfo_bearer_token_unavailable');
  const url = `${APPROVED_GATEWAY_ORIGIN}/graph-worker/v1/identity-registry/${encodeURIComponent(config.registry_id)}/readiness`;
  let response;
  try {
    response = await fetchImpl(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20_000),
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ run_id: config.binding.run.run_id, source_binding_sha256: sourceBindingSha256 }), });
  } catch { return result('blocked', 'readiness_request_unavailable'); }
  const readiness = metadataReadiness(await boundedReadinessJson(response));
  if (!readiness) return result('blocked', 'readiness_response_invalid');
  const extra = { ...receipt, live_probe: true, readiness };
  if (response.status !== 200 || readiness.coverage_ready !== true || readiness.reason !== 'coverage_checked') return result('blocked', 'registry_not_ready', extra);
  return result('ready', undefined, extra);
}

function parseCli(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--check-live') { if (values.checkLive) return null; values.checkLive = true; continue; }
    if (argument !== '--config' && argument !== '--source-binding-sha256' && argument !== '--cfo-project-config') return null;
    const value = argv[++index];
    if (!value || value.startsWith('--') || Object.hasOwn(values, argument)) return null;
    values[argument] = value;
  }
  return { configPath: values['--config'], checkLive: values.checkLive === true, sourceBindingSha256: values['--source-binding-sha256'], cfoProjectConfig: values['--cfo-project-config'] };
}

async function main() {
  const input = parseCli(process.argv.slice(2));
  const output = input ? await runIdentityRegistryProductionPreflight(input) : result('blocked', 'invalid_arguments');
  process.stdout.write(JSON.stringify(output.payload) + '\n');
  process.exitCode = output.exitCode;
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) await main();
