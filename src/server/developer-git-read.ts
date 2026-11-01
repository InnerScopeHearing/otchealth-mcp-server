import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { Readable, Transform, type TransformCallback } from 'node:stream';
import type { AuthContext } from '../auth/bearer.js';
import { DEVELOPER_GIT_REPOSITORIES } from '../github/developer-git-policy.js';

/**
 * Read-only Git smart-HTTP bridge for a fixed set of Developer app repositories.
 * Authentication and upstream credential handling are deliberately injected: this module has no
 * GitHub credential source and cannot contact GitHub unless its caller supplies an upstream.
 */
export interface DeveloperGitReadUpstreamRequest {
  url: string;
  method: 'GET' | 'POST';
  headers: Readonly<Record<string, string>>;
  body?: Readable;
  signal: AbortSignal;
}

export interface DeveloperGitReadUpstreamResponse {
  statusCode: number;
  contentType?: string;
  body: Readable;
}

export interface DeveloperGitReadDependencies {
  authenticate(request: FastifyRequest, reply: FastifyReply): Promise<AuthContext | null>;
  /** Must keep all GitHub credentials server-side, use the fixed URL supplied, and reject redirects. */
  upstream(request: DeveloperGitReadUpstreamRequest): Promise<DeveloperGitReadUpstreamResponse>;
  onError?(event: { kind: string; repo: string; method: string }): void;
}

const UPSTREAM_ORIGIN = 'https://github.com';
const MAX_REQUEST_BYTES = 16 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 512 * 1024 * 1024;
const TOTAL_TIMEOUT_MS = 120_000;
const IDLE_TIMEOUT_MS = 30_000;
const ALLOWED_REQUEST_TYPE = 'application/x-git-upload-pack-request';
const ALLOWED_RESPONSE_TYPE = 'application/x-git-upload-pack-result';
const ALLOWED_DISCOVERY_TYPE = 'application/x-git-upload-pack-advertisement';
const MAX_ACTIVE_PER_CALLER = 2;
const MAX_ACTIVE_TOTAL = 8;
const MAX_STARTS_PER_MINUTE = 10;
const MAX_TRACKED_CALLERS = 256;

function repository(value: unknown): string | null {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.-]{1,100}$/.test(value)) return null;
  return [...DEVELOPER_GIT_REPOSITORIES].find(
    (candidate) => candidate.toLowerCase() === value.toLowerCase(),
  ) ?? null;
}

function routePath(repo: string, suffix: 'info/refs' | 'git-upload-pack'): string {
  return `/InnerScopeHearing/${encodeURIComponent(repo)}.git/${suffix}`;
}

function safeResponseHeaders(reply: FastifyReply, contentType: string | undefined): boolean {
  if (contentType !== ALLOWED_DISCOVERY_TYPE && contentType !== ALLOWED_RESPONSE_TYPE) return false;
  reply.header('content-type', contentType);
  reply.header('cache-control', 'no-store');
  reply.header('x-content-type-options', 'nosniff');
  return true;
}

class ByteLimit extends Transform {
  private seen = 0;
  private idleTimer: NodeJS.Timeout;

  constructor(private readonly limit: number, private readonly exceeded: () => void, private readonly idleMs: number) {
    super();
    this.idleTimer = setTimeout(() => this.destroy(new Error('git_stream_idle_timeout')), idleMs);
    this.idleTimer.unref();
  }

  override _transform(chunk: Buffer | string, encoding: BufferEncoding, callback: TransformCallback): void {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.destroy(new Error('git_stream_idle_timeout')), this.idleMs);
    this.idleTimer.unref();
    const size = Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk, encoding);
    this.seen += size;
    if (this.seen > this.limit) {
      this.exceeded();
      callback(new Error('git_stream_size_limit'));
      return;
    }
    callback(null, chunk);
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    clearTimeout(this.idleTimer);
    if (error) this.exceeded();
    callback(error);
  }
}

/**
 * Register only the two upload-pack operations Git clients need. The binary parser is scoped to
 * this encapsulated plugin and returns the raw request stream; the route counts bytes while
 * forwarding it, so no full Git pack request is buffered in memory.
 */
export function registerDeveloperGitReadRoutes(app: FastifyInstance, deps: DeveloperGitReadDependencies): void {
  app.register(async (scope) => {
    // Limits are per gateway replica; edge rate limiting provides an additional layer.
    const callers = new Map<string, { active: number; starts: number[] }>();
    let activeTotal = 0;
    scope.addContentTypeParser(ALLOWED_REQUEST_TYPE, (request, payload, done) => {
      (request as FastifyRequest & { developerGitBody?: Readable }).developerGitBody = payload as Readable;
      done(null, undefined);
    });

    const handle = async (request: FastifyRequest, reply: FastifyReply): Promise<unknown> => {
      reply.header('cache-control', 'no-store');
      const params = request.params as { repo?: unknown };
      const repo = repository(params.repo);
      if (!repo) return reply.code(404).send({ error: 'not_found' });

      // This machine-to-machine endpoint accepts only header bearer auth. Refuse browser fetches
      // and the legacy query-token carrier before invoking the injected authenticator.
      if (request.headers.origin || request.headers['sec-fetch-site'] || request.headers['sec-fetch-mode'] || request.headers['sec-fetch-dest']) {
        return reply.code(403).send({ error: 'forbidden' });
      }
      if (typeof request.headers.authorization !== 'string' || !request.headers.authorization.trim()) {
        return reply.code(401).send({ error: 'unauthorized' });
      }
      const incoming = new URL(request.raw.url ?? '/', 'http://gateway.invalid');
      if (incoming.searchParams.has('m365_dev_token')) return reply.code(400).send({ error: 'invalid_auth' });

      let auth: AuthContext | null;
      try {
        auth = await deps.authenticate(request, reply);
      } catch {
        return reply.sent ? undefined : reply.code(401).send({ error: 'unauthorized' });
      }
      if (!auth) return reply.sent ? undefined : reply.code(401).send({ error: 'unauthorized' });
      if (auth.caller_agent !== 'developer') return reply.code(403).send({ error: 'forbidden' });

      const method = request.method;
      const isDiscovery = method === 'GET';
      const isUpload = method === 'POST';
      if (!isDiscovery && !isUpload) return reply.code(405).header('allow', 'GET, POST').send();

      if (isDiscovery) {
        if (incoming.search !== '?service=git-upload-pack' || request.headers['transfer-encoding'] ||
            (request.headers['content-length'] && request.headers['content-length'] !== '0')) {
          return reply.code(400).send({ error: 'invalid_service' });
        }
      } else {
        if (incoming.search || request.headers['content-encoding']) return reply.code(400).send({ error: 'invalid_request' });
        const requestType = request.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase();
        if (requestType !== ALLOWED_REQUEST_TYPE) return reply.code(415).send({ error: 'unsupported_media_type' });
        const length = request.headers['content-length'];
        if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > MAX_REQUEST_BYTES)) {
          return reply.code(413).send({ error: 'request_too_large' });
        }
      }

      const caller = auth.caller_hash;
      if (!/^[a-f0-9]{64}$/i.test(caller)) return reply.code(403).send({ error: 'forbidden' });
      const now = Date.now();
      for (const [key, entry] of callers) {
        entry.starts = entry.starts.filter((at) => now - at < 60_000);
        if (entry.active === 0 && entry.starts.length === 0) callers.delete(key);
      }
      if (!callers.has(caller) && callers.size >= MAX_TRACKED_CALLERS) {
        return reply.code(429).header('retry-after', '60').send({ error: 'rate_limited' });
      }
      const state = callers.get(caller) ?? { active: 0, starts: [] };
      state.starts = state.starts.filter((at) => now - at < 60_000);
      if (state.active >= MAX_ACTIVE_PER_CALLER || activeTotal >= MAX_ACTIVE_TOTAL || state.starts.length >= MAX_STARTS_PER_MINUTE) {
        return reply.code(429).header('retry-after', '60').send({ error: 'rate_limited' });
      }
      state.active++;
      state.starts.push(now);
      callers.set(caller, state);
      activeTotal++;
      let released = false;
      const release = (): void => {
        if (released) return;
        released = true;
        state.active--;
        activeTotal--;
      };

      const controller = new AbortController();
      const abort = (): void => controller.abort();
      let timedOut = false;
      let rejectTimeout!: (error: Error) => void;
      const timeout = new Promise<never>((_resolve, reject) => { rejectTimeout = reject; });
      const totalTimer = setTimeout(() => {
        timedOut = true;
        abort();
        rejectTimeout(new Error('git_total_timeout'));
      }, TOTAL_TIMEOUT_MS);
      const onClientClose = (): void => {
        if (!reply.raw.writableEnded) abort();
      };
      request.raw.once('aborted', abort);
      reply.raw.once('close', onClientClose);

      let requestStream: Readable | undefined;
      if (isUpload) {
        const rawBody = (request as FastifyRequest & { developerGitBody?: Readable }).developerGitBody;
        if (!rawBody) {
          clearTimeout(totalTimer);
          release();
          return reply.code(400).send({ error: 'missing_body' });
        }
        requestStream = rawBody.pipe(new ByteLimit(MAX_REQUEST_BYTES, abort, IDLE_TIMEOUT_MS));
        requestStream.once('error', abort);
        rawBody.once('error', () => requestStream?.destroy(new Error('git_request_stream_failed')));
      }

      const suffix = isDiscovery ? 'info/refs' : 'git-upload-pack';
      const url = `${UPSTREAM_ORIGIN}${routePath(repo, suffix)}${isDiscovery ? '?service=git-upload-pack' : ''}`;
      const headers: Record<string, string> = {
        accept: isDiscovery ? ALLOWED_DISCOVERY_TYPE : ALLOWED_RESPONSE_TYPE,
        'user-agent': 'otchealth-developer-git-read',
      };
      if (isUpload) headers['content-type'] = ALLOWED_REQUEST_TYPE;
      if (request.headers['git-protocol'] === 'version=2') headers['git-protocol'] = 'version=2';
      const fail = (kind: string, statusCode: number, body: string): unknown => {
        try { deps.onError?.({ kind, repo, method }); } catch { /* diagnostics must not affect the response */ }
        controller.abort();
        requestStream?.destroy();
        clearTimeout(totalTimer);
        release();
        request.raw.removeListener('aborted', abort);
        reply.raw.removeListener('close', onClientClose);
        return reply.code(statusCode).send({ error: body });
      };

      try {
        const upstreamPromise = deps.upstream({ url, method: isDiscovery ? 'GET' : 'POST', headers, body: requestStream, signal: controller.signal });
        const upstream = await Promise.race([upstreamPromise, timeout]);
        if (upstream.statusCode !== 200) {
          upstream.body.destroy();
          return fail('upstream_status', 502, 'upstream_error');
        }
        const expectedType = isDiscovery ? ALLOWED_DISCOVERY_TYPE : ALLOWED_RESPONSE_TYPE;
        if (upstream.contentType !== expectedType || !safeResponseHeaders(reply, upstream.contentType)) {
          upstream.body.destroy();
          return fail('upstream_content_type', 502, 'upstream_error');
        }

        const limited = upstream.body.pipe(new ByteLimit(MAX_RESPONSE_BYTES, abort, IDLE_TIMEOUT_MS));
        upstream.body.once('error', () => limited.destroy(new Error('git_upstream_stream_failed')));
        limited.once('error', () => {
          try { deps.onError?.({ kind: 'response_stream_failure', repo, method }); } catch { /* best effort */ }
          abort(); upstream.body.destroy(); requestStream?.destroy();
        });
        reply.code(200);
        reply.raw.once('finish', () => {
          clearTimeout(totalTimer);
          release();
          request.raw.removeListener('aborted', abort);
          reply.raw.removeListener('close', onClientClose);
        });
        reply.raw.once('close', () => {
          clearTimeout(totalTimer);
          release();
          if (!reply.raw.writableEnded) {
            abort();
            upstream.body.destroy();
            requestStream?.destroy();
          }
        });
        return reply.send(limited);
      } catch {
        controller.abort();
        requestStream?.destroy();
        return fail(timedOut ? 'timeout' : 'upstream_failure', timedOut ? 504 : 502, timedOut ? 'timeout' : 'upstream_error');
      }
    };

    scope.get('/developer/git/v1/:repo/info/refs', handle);
    scope.post('/developer/git/v1/:repo/git-upload-pack', { bodyLimit: MAX_REQUEST_BYTES }, handle);
  });
}
