import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { canonicalUri, canonicalQueryString, deriveSigningKey, signRequest } from './sigv4.js';

// --- canonicalUri -------------------------------------------------------------------------------

test('canonicalUri: empty/root path canonicalizes to "/"', () => {
  assert.equal(canonicalUri(''), '/');
  assert.equal(canonicalUri('/'), '/');
});

test('canonicalUri: percent-encodes a space within a segment, preserves slashes', () => {
  assert.equal(canonicalUri('/a b/c'), '/a%20b/c');
});

test('canonicalUri: percent-encodes reserved chars AWS requires beyond encodeURIComponent default (!\'()*)', () => {
  // encodeURIComponent leaves !'()* unescaped by default; SigV4 requires them escaped too.
  const out = canonicalUri("/it's-a-test!()*");
  assert.ok(!/[!'()*]/.test(out), `expected all of !'()* to be escaped, got: ${out}`);
  assert.match(out, /%21/); // '!'
  assert.match(out, /%27/); // "'"
});

// --- canonicalQueryString ------------------------------------------------------------------------

test('canonicalQueryString: sorts params by encoded key', () => {
  assert.equal(canonicalQueryString('b=2&a=1'), 'a=1&b=2');
});

test('canonicalQueryString: sorts by value when keys tie', () => {
  assert.equal(canonicalQueryString('k=2&k=1'), 'k=1&k=2');
});

test('canonicalQueryString: empty/undefined -> empty string', () => {
  assert.equal(canonicalQueryString(undefined), '');
  assert.equal(canonicalQueryString(''), '');
});

test('canonicalQueryString: accepts a plain object form, same sorting rule', () => {
  assert.equal(canonicalQueryString({ Version: '2010-05-08', Action: 'ListUsers' }), 'Action=ListUsers&Version=2010-05-08');
});

// --- deriveSigningKey -----------------------------------------------------------------------------

test('deriveSigningKey: matches an independently-computed HMAC chain for a fixed input', () => {
  // Independent re-derivation of the same 4-step HMAC chain the AWS docs specify
  // (kDate -> kRegion -> kService -> kSigning), written separately from sigv4.ts's own
  // implementation so this catches a real algorithmic bug rather than just echoing it back.
  const secret = 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY';
  const dateStamp = '20150830';
  const region = 'us-east-1';
  const service = 'iam';
  const kDate = createHmac('sha256', `AWS4${secret}`).update(dateStamp, 'utf8').digest();
  const kRegion = createHmac('sha256', kDate).update(region, 'utf8').digest();
  const kService = createHmac('sha256', kRegion).update(service, 'utf8').digest();
  const kSigning = createHmac('sha256', kService).update('aws4_request', 'utf8').digest();

  const actual = deriveSigningKey(secret, dateStamp, region, service);
  assert.equal(actual.toString('hex'), kSigning.toString('hex'));
});

// --- signRequest: structural correctness -------------------------------------------------------

const CREDS = { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY' };
const FIXED_NOW = new Date('2015-08-30T12:36:00Z');

test('signRequest: Authorization header has the expected shape and credential scope', () => {
  const { headers } = signRequest({
    method: 'GET',
    host: 'iam.amazonaws.com',
    path: '/',
    query: 'Action=ListUsers&Version=2010-05-08',
    region: 'us-east-1',
    service: 'iam',
    credentials: CREDS,
    now: FIXED_NOW,
  });
  assert.match(
    headers.Authorization,
    /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20150830\/us-east-1\/iam\/aws4_request, SignedHeaders=[a-z;-]+, Signature=[0-9a-f]{64}$/,
  );
  assert.equal(headers['x-amz-date'], '20150830T123600Z');
});

test('signRequest: content-type is added and SIGNED (present in SignedHeaders) whenever a body is sent', () => {
  const { headers } = signRequest({
    method: 'POST',
    host: 'search-otchealth-brain-uqmq2jw23cv4yjnnxblxzb7nny.us-east-1.es.amazonaws.com',
    path: '/memory-exec/_search',
    body: JSON.stringify({ query: { match_all: {} } }),
    region: 'us-east-1',
    service: 'es',
    credentials: CREDS,
    now: FIXED_NOW,
  });
  assert.equal(headers['content-type'], 'application/json');
  const signedHeadersMatch = headers.Authorization.match(/SignedHeaders=([a-z0-9;-]+)/);
  assert.ok(signedHeadersMatch, 'Authorization must carry SignedHeaders');
  const signedHeaders = signedHeadersMatch![1].split(';');
  assert.ok(signedHeaders.includes('content-type'), 'content-type must be a signed header when a body is present');
  assert.ok(signedHeaders.includes('host'));
  assert.ok(signedHeaders.includes('x-amz-date'));
});

test('signRequest: a GET with no body does NOT sign content-type unless explicitly supplied', () => {
  const { headers } = signRequest({
    method: 'GET',
    host: 'example.es.amazonaws.com',
    path: '/idx/_doc/key1',
    region: 'us-east-1',
    service: 'es',
    credentials: CREDS,
    now: FIXED_NOW,
  });
  assert.equal(headers['content-type'], undefined);
  const signedHeaders = headers.Authorization.match(/SignedHeaders=([a-z0-9;-]+)/)![1].split(';');
  assert.ok(!signedHeaders.includes('content-type'));
});

test('signRequest: x-amz-security-token is included and signed when a session token is present', () => {
  const { headers } = signRequest({
    method: 'GET',
    host: 'example.es.amazonaws.com',
    path: '/',
    region: 'us-east-1',
    service: 'es',
    credentials: { ...CREDS, sessionToken: 'FQoGZXIvYXdzEA' },
    now: FIXED_NOW,
  });
  assert.equal(headers['x-amz-security-token'], 'FQoGZXIvYXdzEA');
  const signedHeaders = headers.Authorization.match(/SignedHeaders=([a-z0-9;-]+)/)![1].split(';');
  assert.ok(signedHeaders.includes('x-amz-security-token'));
});

test('signRequest: deterministic for identical input', () => {
  const opts = {
    method: 'POST',
    host: 'example.es.amazonaws.com',
    path: '/idx/_search',
    body: '{"a":1}',
    region: 'us-east-1',
    service: 'es',
    credentials: CREDS,
    now: FIXED_NOW,
  };
  const a = signRequest(opts);
  const b = signRequest(opts);
  assert.equal(a.headers.Authorization, b.headers.Authorization);
});

test('signRequest: a different body changes the signature (payload hash is part of the canonical request)', () => {
  const base = {
    method: 'POST' as const,
    host: 'example.es.amazonaws.com',
    path: '/idx/_search',
    region: 'us-east-1',
    service: 'es',
    credentials: CREDS,
    now: FIXED_NOW,
  };
  const a = signRequest({ ...base, body: '{"a":1}' });
  const b = signRequest({ ...base, body: '{"a":2}' });
  assert.notEqual(a.headers.Authorization, b.headers.Authorization);
});

test('signRequest: independently-recomputed signature matches, for a fixed known input (parallel implementation)', () => {
  // Reimplements the canonical-request -> string-to-sign -> signature chain from scratch in this
  // test (not by calling sigv4.ts's own internals), for one fixed, fully-specified request. This is
  // a genuine cross-check of signRequest's assembly logic, NOT a comparison against AWS's own
  // published Signature Test Suite vectors (this repo has not been validated against those, or
  // against a live AWS request -- see the PR description's "unverified" list).
  const method = 'GET';
  const host = 'search-example.us-east-1.es.amazonaws.com';
  const path = '/_cluster/health';
  const amzDate = '20150830T123600Z';
  const dateStamp = '20150830';
  const region = 'us-east-1';
  const service = 'es';

  const canonicalHeaders = `host:${host}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = 'host;x-amz-date';
  const bodyHash = createHash('sha256').update('').digest('hex');
  const canonicalRequest = [method, path, '', canonicalHeaders, signedHeaders, bodyHash].join('\n');
  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, createHash('sha256').update(canonicalRequest).digest('hex')].join('\n');
  const signingKey = deriveSigningKey(CREDS.secretAccessKey, dateStamp, region, service);
  const expectedSignature = createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex');

  const { headers } = signRequest({ method, host, path, region, service, credentials: CREDS, now: FIXED_NOW });
  const actualSignature = headers.Authorization.match(/Signature=([0-9a-f]{64})$/)![1];
  assert.equal(actualSignature, expectedSignature);
});
