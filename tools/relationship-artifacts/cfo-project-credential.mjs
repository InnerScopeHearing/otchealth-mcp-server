import { readFile, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, resolve } from 'node:path';

const MAX_CONFIG_BYTES = 128 * 1024;
const TOKEN = /^[\x21-\x7e]{16,8192}$/;
const fail = code => { throw Object.assign(new Error(code), { code }); };

function knownProjectConfig(path, projectName, configurationCode) {
  if (typeof path !== 'string' || !isAbsolute(path) || basename(path).toLowerCase() !== 'config.toml' || basename(dirname(path)).toLowerCase() !== '.codex') fail(configurationCode);
  const project = basename(dirname(dirname(resolve(path))));
  if (project.toLowerCase() !== projectName) fail(configurationCode);
  return resolve(path);
}

function quotedBearer(value, missingCode) {
  const match = /^"Bearer ([^"\\\r\n]+)"$/.exec(value.trim());
  if (!match || !TOKEN.test(match[1])) fail(missingCode);
  return match[1];
}

function createProjectBearerTokenProvider({ configPath, projectName, configurationCode, missingCode, readFileImpl, statImpl }) {
  const path = knownProjectConfig(configPath, projectName, configurationCode);
  async function load(signal) {
    signal?.throwIfAborted();
    const info = await statImpl(path);
    if (!info.isFile() || info.size < 1 || info.size > MAX_CONFIG_BYTES) fail(configurationCode);
    const source = await readFileImpl(path, { encoding: 'utf8', signal });
    signal?.throwIfAborted();
    if (Buffer.byteLength(source, 'utf8') !== info.size) fail(configurationCode);
    let sectionName = '';
    const found = [];
    for (const raw of source.replace(/^\uFEFF/, '').split(/\r?\n/)) {
      const section = /^\s*\[([^\]]+)\]\s*(?:#.*)?$/.exec(raw);
      if (section) { sectionName = section[1]; continue; }
      if (sectionName === 'mcp_servers.otchealth.http_headers') {
        const assigned = /^\s*Authorization\s*=\s*("(?:[^"\\\r\n]|\\.)*")\s*(?:#.*)?$/.exec(raw);
        if (assigned) found.push(quotedBearer(assigned[1], missingCode));
      }
      const inline = /^\s*http_headers\s*=\s*\{\s*Authorization\s*=\s*("(?:[^"\\\r\n]|\\.)*")\s*\}\s*(?:#.*)?$/.exec(raw);
      if (inline && sectionName === 'mcp_servers.otchealth') found.push(quotedBearer(inline[1], missingCode));
    }
    if (found.length !== 1) fail(missingCode);
    return found[0];
  }
  return Object.freeze(async (_request, { signal } = {}) => load(signal));
}

/** Reads only the designated CFO project's existing authorized otchealth header. */
export function createCfoProjectBearerTokenProvider({ configPath, readFileImpl = readFile, statImpl = stat } = {}) {
  return createProjectBearerTokenProvider({ configPath, projectName: 'cfo', configurationCode: 'cfo_project_credential_configuration', missingCode: 'cfo_project_credential_missing', readFileImpl, statImpl });
}

/**
 * Reads only the corporate CLO project's existing authorized header. The exact
 * project-root check rejects CLO Personal or another arbitrary Codex configuration.
 */
export function createCloProjectBearerTokenProvider({ configPath, readFileImpl = readFile, statImpl = stat } = {}) {
  return createProjectBearerTokenProvider({ configPath, projectName: 'clo', configurationCode: 'clo_project_credential_configuration', missingCode: 'clo_project_credential_missing', readFileImpl, statImpl });
}