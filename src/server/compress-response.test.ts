import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { gunzipSync, inflateSync } from 'node:zlib';
import type { ServerResponse } from 'node:http';
import { pickEncoding, shouldCompressType, wrapCompressibleResponse } from './compress-response.js';

// ── pure predicates ────────────────────────────────────────────────────────────────────────────
test('pickEncoding prefers gzip, falls back to deflate, honors opt-outs', () => {
  assert.equal(pickEncoding('gzip, deflate, br'), 'gzip');
  assert.equal(pickEncoding('br, gzip'), 'gzip');
  assert.equal(pickEncoding('deflate'), 'deflate');
  assert.equal(pickEncoding('br'), null); // brotli not implemented -> no compression, not a crash
  assert.equal(pickEncoding('identity'), null);
  assert.equal(pickEncoding(undefined), null);
  assert.equal(pickEncoding(''), null);
  assert.equal(pickEncoding('gzip;q=0'), null); // explicit gzip opt-out
  assert.equal(pickEncoding(['gzip', 'deflate']), 'gzip');
});

test('shouldCompressType: JSON/text yes, SSE and binary no', () => {
  assert.equal(shouldCompressType('application/json'), true);
  assert.equal(shouldCompressType('application/json; charset=utf-8'), true);
  assert.equal(shouldCompressType('application/ld+json'), true);
  assert.equal(shouldCompressType('text/plain'), true);
  assert.equal(shouldCompressType('text/event-stream'), false); // SSE must never be compressed
  assert.equal(shouldCompressType('text/event-stream; charset=utf-8'), false);
  assert.equal(shouldCompressType('application/octet-stream'), false);
  assert.equal(shouldCompressType('image/png'), false);
  assert.equal(shouldCompressType(undefined), false);
});

// ── mock ServerResponse capturing the wire ───────────────────────────────────────────────────────
interface MockRes extends EventEmitter {
  writable: boolean;
  headersSent: boolean;
  writeHead(status: number, headers?: Record<string, unknown>): MockRes;
  write(chunk: Buffer | string): boolean;
  end(chunk?: Buffer | string | (() => void)): MockRes;
  destroy(): void;
  flushHeaders(): void;
  _head: { status: number; headers: Record<string, unknown> } | null;
  _body: Buffer;
  _done: Promise<void>;
}

function mockRes(): MockRes {
  const ee = new EventEmitter() as MockRes;
  const chunks: Buffer[] = [];
  let head: { status: number; headers: Record<string, unknown> } | null = null;
  let resolveEnd: () => void = () => {};
  const done = new Promise<void>((r) => (resolveEnd = r));
  ee.writable = true;
  ee.headersSent = false;
  ee.writeHead = (status, headers = {}) => {
    head = { status, headers };
    ee.headersSent = true;
    return ee;
  };
  ee.write = (chunk) => {
    chunks.push(Buffer.from(chunk as Buffer));
    return true;
  };
  ee.end = (chunk) => {
    if (chunk && typeof chunk !== 'function') chunks.push(Buffer.from(chunk as Buffer));
    resolveEnd();
    return ee;
  };
  ee.destroy = () => {};
  ee.flushHeaders = () => {};
  Object.defineProperty(ee, '_head', { get: () => head });
  Object.defineProperty(ee, '_body', { get: () => Buffer.concat(chunks) });
  Object.defineProperty(ee, '_done', { get: () => done });
  return ee;
}

// ── behavior ─────────────────────────────────────────────────────────────────────────────────────
test('compresses a one-shot JSON response and rewrites headers (gzip round-trips)', async () => {
  const raw = mockRes();
  const wrapped = wrapCompressibleResponse(raw as unknown as ServerResponse, 'gzip, deflate');
  assert.notEqual(wrapped, raw, 'a gzip-capable client gets a wrapped response');

  const payload = Buffer.from(JSON.stringify({ tools: Array.from({ length: 500 }, (_v, i) => ({ name: `tool_${i}`, description: 'x'.repeat(64) })) }));
  // Mimic @hono/node-server's one-shot path: writeHead(status, record) then write(body) then end().
  wrapped.writeHead(200, { 'content-type': 'application/json', 'content-length': String(payload.length) });
  wrapped.write(payload);
  wrapped.end();
  await raw._done;

  const headers = raw._head?.headers as Record<string, unknown>;
  assert.equal(headers['content-encoding'], 'gzip', 'content-encoding is set');
  assert.equal('content-length' in headers, false, 'stale content-length is removed (response is chunked)');
  assert.match(String(headers['vary']), /accept-encoding/i, 'Vary: Accept-Encoding is set for caches');
  assert.ok(raw._body.length < payload.length, 'the wire body is smaller than the raw payload');
  assert.deepEqual(gunzipSync(raw._body), payload, 'gunzip restores the exact original bytes');
});

test('deflate path round-trips when the client only accepts deflate', async () => {
  const raw = mockRes();
  const wrapped = wrapCompressibleResponse(raw as unknown as ServerResponse, 'deflate');
  const payload = Buffer.from('{"ok":true,"data":"' + 'y'.repeat(2000) + '"}');
  wrapped.writeHead(200, { 'content-type': 'application/json' });
  wrapped.end(payload);
  await raw._done;
  assert.equal((raw._head?.headers as Record<string, unknown>)['content-encoding'], 'deflate');
  assert.deepEqual(inflateSync(raw._body), payload);
});

test('SSE (text/event-stream) passes through byte-for-byte, never compressed', () => {
  const raw = mockRes();
  const wrapped = wrapCompressibleResponse(raw as unknown as ServerResponse, 'gzip');
  wrapped.writeHead(200, { 'content-type': 'text/event-stream' });
  wrapped.write('data: one\n\n');
  wrapped.write('data: two\n\n');
  wrapped.end();
  const headers = raw._head?.headers as Record<string, unknown>;
  assert.equal(headers['content-encoding'], undefined, 'SSE is never given a content-encoding');
  assert.equal(raw._body.toString(), 'data: one\n\ndata: two\n\n', 'SSE bytes are unchanged');
});

test('already-encoded responses are not double-compressed', () => {
  const raw = mockRes();
  const wrapped = wrapCompressibleResponse(raw as unknown as ServerResponse, 'gzip');
  const pre = Buffer.from([0x1f, 0x8b, 0x08, 0x00]); // pretend already-gzipped
  wrapped.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' });
  wrapped.write(pre);
  wrapped.end();
  assert.deepEqual(raw._body, pre, 'body is passed through untouched');
});

test('a client that accepts no supported encoding gets the original response object (zero overhead)', () => {
  const raw = mockRes();
  assert.equal(wrapCompressibleResponse(raw as unknown as ServerResponse, undefined), raw);
  assert.equal(wrapCompressibleResponse(raw as unknown as ServerResponse, 'identity'), raw);
  assert.equal(wrapCompressibleResponse(raw as unknown as ServerResponse, 'br'), raw);
});

test('non-writeHead/write/end members delegate to the real socket', () => {
  const raw = mockRes();
  let flushed = false;
  raw.flushHeaders = () => {
    flushed = true;
  };
  const wrapped = wrapCompressibleResponse(raw as unknown as ServerResponse, 'gzip') as unknown as MockRes;
  wrapped.flushHeaders();
  assert.equal(flushed, true, 'flushHeaders delegates to the real response');
  assert.equal(wrapped.writable, true, 'property reads delegate to the real response');
});
