import { readFile, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, resolve } from 'node:path';

const MAX_CONFIG_BYTES = 128 * 1024;
const TOKEN = /^[\x21-\x7e]{16,8192}$/;
const fail = code => { throw Object.assign(new Error(code), { code }); };

function knownCfoConfig(path) {
  if (typeof path !== 'string' || !isAbsolute(path) || basename(path).toLowerCase() !== 'config.toml' || basename(dirname(path)).toLowerCase() !== '.codex') {
    fail('cfo_project_credential_configuration');
  }
  const project = basename(dirname(dirname(resolve(path))));
  if (project.toLowerCase() !== 'cfo') fail('cfo_project_credential_configuration');
  return resolve(path);
}

function quotedBearer(value) {
  const match = /^"Bearer ([^"\\\r\n]+)"$/.exec(value.trim());
  if (!match || !TOKEN.test(match[1])) fail('cfo_project_credential_missing');
  return match[1];
}

/**
 * Reads only the designated CFO project's already-authorized otchealth header.
 * The bearer remains in this process closure, is never written, logged, placed in
 * argv, or copied into a child environment. This intentionally is not a general
 * TOML reader and rejects alternate servers, paths, duplicate values, and escapes.
 */
export function createCfoProjectBearerTokenProvider({ configPath, readFileImpl = readFile, statImpl = stat } = {}) {
  const path = knownCfoConfig(configPath);
  async function load(signal) {
    signal?.throwIfAborted();
    const info = await statImpl(path);
    if (!info.isFile() || info.size < 1 || info.size > MAX_CONFIG_BYTES) fail('cfo_project_credential_configuration');
    const source = await readFileImpl(path, { encoding: 'utf8', signal });
    signal?.throwIfAborted();
    if (Buffer.byteLength(source, 'utf8') !== info.size) fail('cfo_project_credential_configuration');
    let sectionName = '';
    const found = [];
    for (const raw of source.replace(/^\uFEFF/, '').split(/\r?\n/)) {
      const section = /^\s*\[([^\]]+)\]\s*(?:#.*)?$/.exec(raw);
      if (section) { sectionName = section[1]; continue; }
      if (sectionName === 'mcp_servers.otchealth.http_headers') {
        const assigned = /^\s*Authorization\s*=\s*("(?:[^"\\\r\n]|\\.)*")\s*(?:#.*)?$/.exec(raw);
        if (assigned) found.push(quotedBearer(assigned[1]));
      }
      const inline = /^\s*http_headers\s*=\s*\{\s*Authorization\s*=\s*("(?:[^"\\\r\n]|\\.)*")\s*\}\s*(?:#.*)?$/.exec(raw);
      if (inline && sectionName === 'mcp_servers.otchealth') found.push(quotedBearer(inline[1]));
    }
    if (found.length !== 1) fail('cfo_project_credential_missing');
    return found[0];
  }
  // Re-read for each request so a long-running worker observes rotation or removal.
  // Never retain a previously accepted credential after a failed refresh.
  return Object.freeze(async (_request, { signal } = {}) => load(signal));
}
