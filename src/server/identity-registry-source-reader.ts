import { createHash } from 'node:crypto';
import { resolveAwsCredentials, signRequest } from '../search/sigv4.js';

const BUCKET = 'otchealth-finance-legal-dr-55c84f6b';
const REGION = 'us-east-1';
const HASH = /^[a-f0-9]{64}$/;
const VERSION = /^[A-Za-z0-9._~+/-]{1,1024}$/;
const KEY = /^[a-zA-Z0-9][a-zA-Z0-9_./-]{0,1023}$/;
const MAX_BYTES = 512 * 1024;
export type SourceObjectRef = { key: string; version_id?: string; sha256?: string };
export type SourceJsonReader = (request: SourceObjectRef, options: { signal: AbortSignal }) =>
  Promise<{ value: unknown; version_id: string }>;
type Signed = { headers: Record<string, string> };
export type SourceReaderDependencies = {
  fetch: typeof fetch;
  sign: (request: { method: string; host: string; path: string; query: string }) => Promise<Signed>;
};
function unavailable(): never { throw new Error('identity_source_unavailable'); }
function validKey(key: string): boolean {
  return KEY.test(key) && key.split('/').every(part => part && part !== '.' && part !== '..');
}

/** Fixed finance ring, exact prefix, bounded versioned reads. No source text is logged. */
export function createIdentityRegistrySourceReader(
  config: { prefix: string; timeoutMs?: number },
  injected?: Partial<SourceReaderDependencies>,
): SourceJsonReader {
  if (!validKey(config.prefix) || !config.prefix.startsWith('graph-trial/')) unavailable();
  const timeoutMs = config.timeoutMs ?? 10_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 15_000) unavailable();
  const prefix = config.prefix + '/';
  const transport = injected?.fetch ?? fetch;
  const sign = injected?.sign ?? (async request => {
    const credentials = await resolveAwsCredentials();
    if (!credentials) unavailable();
    return signRequest({ ...request, credentials, service: 's3', region: REGION });
  });
  return async (request, { signal }) => {
    if (signal.aborted || !validKey(request.key) || !request.key.startsWith(prefix) ||
        (request.version_id !== undefined && (!VERSION.test(request.version_id) || request.version_id === 'null')) ||
        (request.sha256 !== undefined && !HASH.test(request.sha256)) ||
        ((request.sha256 === undefined) !== (request.version_id === undefined))) unavailable();
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const abort = () => controller.abort();
    const cancel = () => { if (reader) void reader.cancel().catch(() => undefined); };
    signal.addEventListener('abort', abort, { once: true });
    controller.signal.addEventListener('abort', cancel, { once: true });
    const stopped = new Promise<never>((_, reject) => {
      controller.signal.addEventListener('abort', () => reject(new Error('identity_source_unavailable')), { once: true });
      timer = setTimeout(abort, timeoutMs);
    });
    const check = () => { if (signal.aborted || controller.signal.aborted) unavailable(); };
    try {
      return await Promise.race([stopped, (async () => {
        check();
        const host = `${BUCKET}.s3.${REGION}.amazonaws.com`;
        const path = '/' + request.key;
        const query = request.version_id ? `versionId=${encodeURIComponent(request.version_id)}` : '';
        const signed = await sign({ method: 'GET', host, path, query });
        check();
        const response = await transport(`https://${host}${path}${query ? '?' + query : ''}`, {
          method: 'GET', headers: signed.headers, signal: controller.signal, redirect: 'error',
        });
        check();
        const version = response.headers.get('x-amz-version-id');
        const length = response.headers.get('content-length');
        const encryption = response.headers.get('x-amz-server-side-encryption');
        if (response.status !== 200 || !version || !VERSION.test(version) || version === 'null' ||
            (request.version_id !== undefined && request.version_id !== version) ||
            (encryption !== 'AES256' && encryption !== 'aws:kms') ||
            (length !== null && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) > MAX_BYTES)) ||
            !response.body) unavailable();
        reader = response.body.getReader();
        const chunks: Buffer[] = [];
        let bytes = 0;
        for (;;) {
          check();
          const part = await reader.read();
          check();
          if (part.done) break;
          bytes += part.value.byteLength;
          if (bytes > MAX_BYTES) unavailable();
          chunks.push(Buffer.from(part.value));
        }
        const body = Buffer.concat(chunks, bytes);
        if (length !== null && Number(length) !== bytes) unavailable();
        if (request.sha256 && createHash('sha256').update(body).digest('hex') !== request.sha256) unavailable();
        const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
        check();
        return { value, version_id: version };
      })()]);
    } catch { unavailable(); }
    finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      controller.signal.removeEventListener('abort', cancel);
      cancel();
    }
  };
}
