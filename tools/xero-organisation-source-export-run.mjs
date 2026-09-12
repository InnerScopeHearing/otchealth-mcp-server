#!/usr/bin/env node
/**
 * Source-owner entrypoint for the Xero Organisation identity record. It is
 * intentionally separate from the registry exporter: this step produces the
 * immutable source pin and safe record only after CTO deploys its storage
 * contract. It never prints raw Xero output, credentials, or record values.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_DEPLOYMENT_BYTES = 32 * 1024;
const PRIVATE_KEY = /-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----/;
const fail = code => { throw Object.assign(new Error(code), { code }); };

export function parseCli(argv) {
  if (!Array.isArray(argv) || argv.length !== 4) return null;
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index], value = argv[index + 1];
    if (!['--deployment', '--output'].includes(flag) || typeof value !== 'string' || !isAbsolute(value) || values.has(flag)) return null;
    values.set(flag, resolve(value));
  }
  return { deployment: values.get('--deployment'), output: values.get('--output') };
}

async function deployment(path, read = readFile) {
  let raw;
  try { raw = await read(path, 'utf8'); } catch { fail('xero_organisation_deployment_unavailable'); }
  if (Buffer.byteLength(raw, 'utf8') < 1 || Buffer.byteLength(raw, 'utf8') > MAX_DEPLOYMENT_BYTES || PRIVATE_KEY.test(raw)) fail('xero_organisation_deployment_invalid');
  let value;
  try { value = JSON.parse(raw); } catch { fail('xero_organisation_deployment_invalid'); }
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).sort().join('\0') !== 'deployment\0schema' ||
      value.schema !== 'cfo-xero-organisation-source-deployment-v1') fail('xero_organisation_deployment_invalid');
  return value.deployment;
}

/** Testable command core. The production CLI supplies the compiled adapter. */
export async function runXeroOrganisationSourceExport({ argv, persist, read = readFile, write = writeFile } = {}) {
  const paths = parseCli(argv);
  if (!paths || typeof persist !== 'function') fail('xero_organisation_arguments_invalid');
  const configured = await deployment(paths.deployment, read);
  const result = await persist(configured);
  const output = {
    schema: 'cfo-xero-organisation-source-export-result-v1',
    record: result.record,
    receipt: result.receipt,
  };
  await write(paths.output, JSON.stringify(output) + '\n', { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  return { output_written: true };
}

async function main() {
  try {
    const { xeroConfigured } = await import('../dist/tools/xero/client.js');
    if (!xeroConfigured()) fail('xero_organisation_connector_unavailable');
    const { persistProvisionedXeroOrganisationSource } = await import('../dist/server/xero-organisation-source-adapter.js');
    await runXeroOrganisationSourceExport({ argv: process.argv.slice(2), persist: persistProvisionedXeroOrganisationSource });
    process.stdout.write(JSON.stringify({ schema: 'cfo-xero-organisation-source-export-run-v1', status: 'persisted', output_written: true }) + '\n');
  } catch (error) {
    process.stderr.write(`${error?.code ?? 'xero_organisation_source_export_unavailable'}\n`);
    process.exitCode = 1;
  }
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) await main();
