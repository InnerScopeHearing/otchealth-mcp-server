import zlib from 'node:zlib';
import type { ServerResponse } from 'node:http';

// compress-response — transparent gzip/deflate compression for the MCP JSON hot path.
//
// WHY this exists (not @fastify/compress): the /mcp route hands `reply.raw` (the raw Node
// ServerResponse) straight to the MCP SDK's StreamableHTTPServerTransport, which delegates to
// @hono/node-server's writer. That path bypasses Fastify's reply lifecycle entirely, so Fastify's
// onSend hooks (and therefore @fastify/compress) never see the response. The `tools/list` catalog is
// ~1.9 MB uncompressed and is fetched on every client connect; gzip shrinks it ~16x (measured
// 1,898,964 -> ~119 KB). Compressing at the origin is deterministic regardless of HTTP method
// (tools/list is a POST, which Front Door / APIM edge compression does not reliably compress).
//
// HOW: wrap the raw response in a Proxy that intercepts ONLY writeHead/write/end. Every other
// property (the EventEmitter surface, stream backpressure, writableFinished, internal symbols the
// hono writer sets like the outgoing-ended callback) delegates to the real socket via Reflect, so
// the wrapper changes exactly one behavior and inherits correct behavior for everything else.
//
// SAFETY: only compressible JSON/text content types are compressed; text/event-stream (SSE) and any
// already-encoded response pass through byte-for-byte untouched. If the client does not advertise a
// supported encoding, the real response is returned unwrapped (zero overhead, zero risk).

/** Content types we compress. JSON (and +json) and text/*, but NEVER SSE (breaks streaming). */
export function shouldCompressType(contentType: string | undefined | null): boolean {
  if (!contentType) return false;
  const ct = String(contentType).toLowerCase();
  if (ct.includes('text/event-stream')) return false;
  return /^application\/json|^application\/[^;]*\+json|^text\//.test(ct);
}

/** Pick a response encoding from the client's Accept-Encoding. gzip preferred (max compatibility). */
export function pickEncoding(acceptEncoding: string | string[] | undefined): 'gzip' | 'deflate' | null {
  const ae = (Array.isArray(acceptEncoding) ? acceptEncoding.join(',') : acceptEncoding || '').toLowerCase();
  if (!ae) return null;
  // Honor an explicit `identity` / `gzip;q=0` opt-out.
  if (/(^|,)\s*gzip\s*;\s*q=0(\.0+)?\s*(,|$)/.test(ae)) return null;
  if (/(^|,)\s*gzip\b/.test(ae)) return 'gzip';
  if (/(^|,)\s*deflate\b/.test(ae)) return 'deflate';
  return null;
}

/** Case-insensitive read of a header from a Node OutgoingHttpHeaders record. */
function getHeader(headers: Record<string, unknown>, name: string): unknown {
  if (name in headers) return headers[name];
  const lower = name.toLowerCase();
  for (const k of Object.keys(headers)) if (k.toLowerCase() === lower) return headers[k];
  return undefined;
}
/** Case-insensitive delete of a header from a Node OutgoingHttpHeaders record. */
function deleteHeader(headers: Record<string, unknown>, name: string): void {
  const lower = name.toLowerCase();
  for (const k of Object.keys(headers)) if (k.toLowerCase() === lower) delete headers[k];
}

type Headers = Record<string, unknown>;

/**
 * Wrap a Node ServerResponse so compressible JSON/text responses are gzip/deflate compressed on the
 * wire. Returns the original `res` unchanged when the client accepts no supported encoding.
 * `makeCompressor` is injectable for tests (defaults to zlib).
 */
export function wrapCompressibleResponse(
  res: ServerResponse,
  acceptEncoding: string | string[] | undefined,
  makeCompressor: (enc: 'gzip' | 'deflate') => zlib.Gzip | zlib.Deflate = (enc) =>
    enc === 'gzip' ? zlib.createGzip({ level: 6 }) : zlib.createDeflate({ level: 6 }),
): ServerResponse {
  const enc = pickEncoding(acceptEncoding);
  if (!enc) return res;

  let mode: 'undecided' | 'passthrough' | 'compress' = 'undecided';
  let compressor: zlib.Gzip | zlib.Deflate | null = null;

  const startCompression = (statusCode: number, headers: Headers): void => {
    mode = 'compress';
    const h: Headers = { ...headers };
    deleteHeader(h, 'content-length'); // length changes after compression; response becomes chunked
    h['content-encoding'] = enc;
    const existingVary = getHeader(h, 'vary');
    const varyStr = existingVary ? String(existingVary) : '';
    if (!/\baccept-encoding\b/i.test(varyStr)) {
      h['vary'] = varyStr ? `${varyStr}, Accept-Encoding` : 'Accept-Encoding';
    }
    res.writeHead(statusCode, h as Record<string, string>);
    compressor = makeCompressor(enc);
    compressor.on('data', (chunk: Buffer) => {
      res.write(chunk);
    });
    compressor.on('end', () => {
      res.end();
    });
    compressor.on('error', () => {
      try {
        res.destroy();
      } catch {
        /* already destroyed */
      }
    });
  };

  const handleWriteHead = (args: unknown[]): void => {
    const statusCode = args[0] as number;
    // Node signatures: writeHead(status, headers) | writeHead(status, statusMessage, headers)
    const maybeHeaders = args.length >= 3 ? args[2] : args[1];
    const headers = maybeHeaders && typeof maybeHeaders === 'object' && !Array.isArray(maybeHeaders)
      ? (maybeHeaders as Headers)
      : null;
    const ct = headers ? (getHeader(headers, 'content-type') as string | undefined) : undefined;
    const alreadyEncoded = headers ? getHeader(headers, 'content-encoding') : undefined;
    if (headers && shouldCompressType(ct) && !alreadyEncoded) {
      startCompression(statusCode, headers);
    } else {
      mode = 'passthrough';
      (res.writeHead as (...a: unknown[]) => unknown)(...args);
    }
  };

  return new Proxy(res, {
    get(target, prop, receiver) {
      if (prop === 'writeHead') {
        return (...args: unknown[]) => {
          handleWriteHead(args);
          return receiver; // writeHead returns the response for chaining
        };
      }
      if (prop === 'write') {
        return (chunk: unknown, encoding?: unknown, cb?: unknown): boolean => {
          if (mode === 'compress' && compressor) {
            return compressor.write(
              chunk as Buffer,
              (typeof encoding === 'function' ? undefined : encoding) as BufferEncoding,
              (typeof encoding === 'function' ? encoding : cb) as (() => void) | undefined,
            );
          }
          return (target.write as (...a: unknown[]) => boolean)(chunk, encoding, cb);
        };
      }
      if (prop === 'end') {
        return (chunk?: unknown, encoding?: unknown, cb?: unknown) => {
          if (mode === 'compress' && compressor) {
            if (chunk && typeof chunk !== 'function') compressor.write(chunk as Buffer);
            compressor.end();
            const done = typeof chunk === 'function' ? chunk : typeof encoding === 'function' ? encoding : cb;
            if (typeof done === 'function') (done as () => void)();
            return receiver;
          }
          return (target.end as (...a: unknown[]) => unknown)(chunk, encoding, cb);
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
    set(target, prop, value) {
      return Reflect.set(target, prop, value, target);
    },
  }) as ServerResponse;
}
