import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { azSig } from './blob-store.js';

// Locks the Azure Blob SharedKey signature construction to the EXACT StringToSign used by the proven
// skills/legal/legal.mjs `azSig` against this same account. If the 13-field StringToSign, the
// canonicalized-headers order, the canonicalized-resource form, or the HMAC-over-base64-decoded-key
// ever drift, this test fails — the wire signature must stay byte-identical to the working skill.

// A throwaway, syntactically-valid base64 key (NOT a real credential).
const ACCT = 'otchealthlegalstore';
const KEY = Buffer.from('unit-test-shared-key-not-a-real-secret').toString('base64');

/** Independent reference implementation of the legal.mjs azSig StringToSign, computed here from
 * first principles so the test is a genuine cross-check rather than a copy of the impl. */
function referenceSig(
  method: string,
  container: string,
  blob: string,
  xms: Record<string, string>,
  query: Record<string, string> | null,
  contentLength: string,
  contentType: string,
): string {
  const canonHeaders =
    Object.keys(xms).sort().map((k) => `${k.toLowerCase()}:${xms[k]}`).join('\n') + '\n';
  let canonResource = `/${ACCT}/${container}` + (blob ? `/${blob}` : '');
  if (query) for (const k of Object.keys(query).sort()) canonResource += `\n${k.toLowerCase()}:${query[k]}`;
  const sts = [method, '', '', contentLength || '', '', contentType || '', '', '', '', '', '', '', canonHeaders + canonResource].join('\n');
  const sig = crypto.createHmac('sha256', Buffer.from(KEY, 'base64')).update(sts, 'utf8').digest('base64');
  return `SharedKey ${ACCT}:${sig}`;
}

test('GET blob signature matches the reference StringToSign', () => {
  const xms = { 'x-ms-date': 'Mon, 06 Jul 2026 00:00:00 GMT', 'x-ms-version': '2021-06-08' };
  const got = azSig(ACCT, KEY, 'GET', 'personal', 'matters/2026-divorce.json', xms, null, '', '');
  assert.equal(got, referenceSig('GET', 'personal', 'matters/2026-divorce.json', xms, null, '', ''));
});

test('PUT blob signature includes Content-Length + Content-Type in the right StringToSign fields', () => {
  const xms = { 'x-ms-blob-type': 'BlockBlob', 'x-ms-date': 'Mon, 06 Jul 2026 00:00:00 GMT', 'x-ms-version': '2021-06-08' };
  const got = azSig(ACCT, KEY, 'PUT', 'company', 'filings/petition.pdf', xms, null, '2048', 'application/pdf');
  assert.equal(got, referenceSig('PUT', 'company', 'filings/petition.pdf', xms, null, '2048', 'application/pdf'));
});

test('list (comp=list) signature folds the canonicalized query into the resource', () => {
  const xms = { 'x-ms-date': 'Mon, 06 Jul 2026 00:00:00 GMT', 'x-ms-version': '2021-06-08' };
  const query = { comp: 'list', prefix: 'matters/', restype: 'container' };
  const got = azSig(ACCT, KEY, 'GET', 'personal', '', xms, query, '', '');
  assert.equal(got, referenceSig('GET', 'personal', '', xms, query, '', ''));
});

test('signature is HMAC-SHA256 over the BASE64-DECODED key (not the raw string)', () => {
  const xms = { 'x-ms-date': 'x', 'x-ms-version': '2021-06-08' };
  const withDecoded = azSig(ACCT, KEY, 'GET', 'company', 'a.json', xms, null, '', '');
  // Recompute using the RAW (non-decoded) key — must differ, proving we base64-decode the key.
  const canonHeaders = Object.keys(xms).sort().map((k) => `${k.toLowerCase()}:${xms[k]}`).join('\n') + '\n';
  const sts = ['GET', '', '', '', '', '', '', '', '', '', '', '', canonHeaders + `/${ACCT}/company/a.json`].join('\n');
  const wrong = `SharedKey ${ACCT}:${crypto.createHmac('sha256', KEY).update(sts, 'utf8').digest('base64')}`;
  assert.notEqual(withDecoded, wrong);
});
