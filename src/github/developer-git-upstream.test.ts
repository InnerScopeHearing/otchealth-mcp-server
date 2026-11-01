import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import { createDeveloperGitUpstream } from './developer-git-upstream.js';

const base = 'https://github.com/InnerScopeHearing/iheartest.git/';

test('fixed Git read origin sends only server-supplied App authentication', async () => {
  const previous = getGlobalDispatcher();
  const mock = new MockAgent();
  mock.disableNetConnect();
  setGlobalDispatcher(mock);
  const token = 'fictional-app-token';
  try {
    mock.get('https://github.com').intercept({
      path: '/InnerScopeHearing/iheartest.git/info/refs?service=git-upload-pack',
      method: 'GET',
      headers: { authorization: 'Basic ' + Buffer.from('x-access-token:' + token).toString('base64') },
    }).reply(200, 'synthetic-git-response', { headers: { 'content-type': 'application/x-git-upload-pack-advertisement' } });
    const read = createDeveloperGitUpstream(async () => token);
    const result = await read({ url: base + 'info/refs?service=git-upload-pack', method: 'GET',
      headers: { authorization: 'fictional-caller-authorization' }, signal: new AbortController().signal });
    assert.equal(result.statusCode, 200);
    const chunks: Buffer[] = [];
    for await (const chunk of result.body) chunks.push(Buffer.from(chunk));
    assert.equal(Buffer.concat(chunks).toString(), 'synthetic-git-response');
    assert.equal(JSON.stringify({ statusCode: result.statusCode, contentType: result.contentType }).includes(token), false);
    mock.assertNoPendingInterceptors();
  } finally {
    setGlobalDispatcher(previous);
    await mock.close();
  }
});

test('wrong repository, origin, operation and protocol are rejected before token mint', async () => {
  let calls = 0;
  const read = createDeveloperGitUpstream(async () => { calls++; return 'fictional-token'; });
  const signal = new AbortController().signal;
  for (const input of [
    { url: 'https://evil.invalid/InnerScopeHearing/iheartest.git/info/refs?service=git-upload-pack', method: 'GET' as const },
    { url: 'https://github.com/InnerScopeHearing/medreview.git/info/refs?service=git-upload-pack', method: 'GET' as const },
    { url: base + 'info/refs?service=git-receive-pack', method: 'GET' as const },
    { url: base + 'git-receive-pack', method: 'POST' as const },
  ]) {
    await assert.rejects(() => read({ ...input, headers: {}, signal }), /Invalid/);
  }
  await assert.rejects(() => read({ url: base + 'info/refs?service=git-upload-pack', method: 'GET',
    headers: { 'git-protocol': 'version=9' }, signal }), /Invalid/);
  assert.equal(calls, 0);
});

test('an upstream redirect is not followed and its destination is not exposed', async () => {
  const previous = getGlobalDispatcher();
  const mock = new MockAgent();
  mock.disableNetConnect();
  setGlobalDispatcher(mock);
  try {
    mock.get('https://github.com').intercept({
      path: '/InnerScopeHearing/iheartest.git/info/refs?service=git-upload-pack', method: 'GET',
    }).reply(302, '', { headers: { location: 'https://untrusted.invalid/collect' } });
    const read = createDeveloperGitUpstream(async () => 'fictional-token');
    const result = await read({ url: base + 'info/refs?service=git-upload-pack', method: 'GET',
      headers: {}, signal: new AbortController().signal });
    assert.equal(result.statusCode, 302);
    assert.equal('location' in result, false);
    result.body.destroy();
    mock.assertNoPendingInterceptors();
  } finally {
    setGlobalDispatcher(previous);
    await mock.close();
  }
});
