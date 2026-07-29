/**
 * Shared "write bytes to a safe local path" helper.
 *
 * Some tool results (an offloaded JIT payload, a downloaded OneDrive file) are too large or too
 * awkward to round-trip through the agent's own context without risk of corruption (base64
 * retyping, truncation). This gives those tools a way to persist bytes directly to disk instead
 * of returning them inline, with a sha256 the caller can compare against a hash returned
 * elsewhere (e.g. graph_drive_upload) to PROVE round-trip integrity rather than eyeballing it.
 *
 * SAFETY: every write is confined to a fixed root directory (GATEWAY_LOCAL_WRITE_ROOT, default a
 * dedicated tmp subdir) and refuses any ".." path segment outright — the same bad_path guard
 * xero_get / xero_request already use for the identical class of problem (see tools/xero/tools.ts).
 * A path that resolves outside the root even without a literal ".." (e.g. an absolute path on
 * some platforms) is refused too. Never throws on a bad path; callers get a structured refusal.
 */
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

const DEFAULT_WRITE_ROOT = path.join(os.tmpdir(), 'gateway-local-writes');

/** The confined root every local write is resolved against. Env-overridable, never unbounded. */
export function localWriteRoot(): string {
  return process.env.GATEWAY_LOCAL_WRITE_ROOT || DEFAULT_WRITE_ROOT;
}

export interface SafePathResult {
  ok: boolean;
  abs: string;
  reason?: 'bad_path' | 'outside_write_root';
}

/**
 * Resolve `requestedPath` against the write root, refusing traversal. Pure/testable (no IO).
 * Mirrors xero_get/xero_request's `path.includes('..')` guard, plus a resolved-path containment
 * check so a sneaky absolute path can't escape the root even without a literal "..".
 */
export function resolveSafeWritePath(requestedPath: string): SafePathResult {
  const root = localWriteRoot();
  if (!requestedPath || typeof requestedPath !== 'string') {
    return { ok: false, abs: '', reason: 'bad_path' };
  }
  if (requestedPath.includes('..')) {
    return { ok: false, abs: '', reason: 'bad_path' };
  }
  const abs = path.resolve(root, requestedPath);
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (abs !== root && !abs.startsWith(rootWithSep)) {
    return { ok: false, abs: '', reason: 'outside_write_root' };
  }
  return { ok: true, abs };
}

export interface LocalWriteResult {
  path: string;
  bytes: number;
  sha256: string;
}

/** Write `content` to `requestedPath` (confined to the write root) and return the sha256 proof. */
export async function writeLocalFile(requestedPath: string, content: Buffer): Promise<LocalWriteResult> {
  const safe = resolveSafeWritePath(requestedPath);
  if (!safe.ok) {
    throw new Error(`refused to write local file: ${safe.reason} ("${requestedPath}")`);
  }
  await mkdir(path.dirname(safe.abs), { recursive: true });
  await writeFile(safe.abs, content);
  const sha256 = createHash('sha256').update(content).digest('hex');
  return { path: safe.abs, bytes: content.length, sha256 };
}
