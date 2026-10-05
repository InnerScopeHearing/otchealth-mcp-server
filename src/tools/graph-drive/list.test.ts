import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { GraphDriveFetch } from '../../graph/drive-client.js';

process.env.CIO_SITE_ID ||= 'test';
process.env.CIO_TRACK_KEY ||= 'test';
process.env.CIO_APP_API_BEARER ||= 'test';
process.env.PERPLEXITY_CONNECTOR_TOKEN ||= 'p'.repeat(32);
process.env.ADMIN_REVOKE_TOKEN ||= 'a'.repeat(32);
process.env.N8N_WEBHOOK_SECRET ||= 'n'.repeat(32);
process.env.GRAPH_CLIENT_SECRET ||= 'synthetic-test-signing-key';

const { listFolderPageForOwner } = await import('../../graph/drive-client.js');

const owner = 'matthew@innd.com';
const folder = '5-Media/App Screenshots and Videos/AWARE/1.4.0 (1779565789)/coverage-report';
const pageTwo = 'https://graph.microsoft.com/v1.0/users/matthew%40innd.com/drive/root:/5-Media/App%20Screenshots%20and%20Videos/AWARE/1.4.0%20(1779565789)/coverage-report:/children?$top=2&$skiptoken=opaque-token';

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

test('Graph Drive paged listing follows a validated cursor and returns QuickXor metadata', async () => {
  const calls: string[] = [];
  const replies = [
    response({
      value: [{ name: '001.png', id: 'a', size: 12, file: { mimeType: 'image/png', hashes: { quickXorHash: 'qx-a' } } }],
      '@odata.nextLink': pageTwo,
    }),
    response({ value: [{ name: '002.png', id: 'b', size: 24, file: { hashes: { quickXorHash: 'qx-b' } } }] }),
  ];
  const fakeFetch: GraphDriveFetch = async (_method, path) => {
    calls.push(path);
    const next = replies.shift();
    assert.ok(next);
    return next;
  };

  const first = await listFolderPageForOwner(folder, owner, 2, undefined, fakeFetch);
  assert.equal(first.files.length, 1);
  assert.equal(first.files[0].quickXorHash, 'qx-a');
  assert.ok(first.nextCursor);
  assert.equal(first.nextCursor.includes('opaque-token'), false, 'cursor does not expose raw Graph skip token');

  const second = await listFolderPageForOwner(folder, owner, 2, first.nextCursor!, fakeFetch);
  assert.equal(second.files[0].name, '002.png');
  assert.equal(second.files[0].quickXorHash, 'qx-b');
  assert.equal(second.nextCursor, null);
  assert.equal(calls.length, 2);
  assert.match(calls[0], /\$top=2$/);
  assert.equal(calls[1], pageTwo);
});

test('cursor validation binds continuation to owner, folder, and page size before fetching', async () => {
  let calls = 0;
  const fakeFetch: GraphDriveFetch = async () => {
    calls++;
    return response({ value: [] });
  };
  const first = await listFolderPageForOwner(folder, owner, 2, undefined, async () => response({ value: [], '@odata.nextLink': pageTwo }));
  assert.ok(first.nextCursor);
  await assert.rejects(listFolderPageForOwner(`${folder}/other`, owner, 2, first.nextCursor!, fakeFetch), /Cursor does not match/);
  await assert.rejects(listFolderPageForOwner(folder, 'other@innd.com', 2, first.nextCursor!, fakeFetch), /Cursor does not match/);
  await assert.rejects(listFolderPageForOwner(folder, owner, 3, first.nextCursor!, fakeFetch), /Cursor does not match/);
  await assert.rejects(listFolderPageForOwner(folder, owner, 201, undefined, fakeFetch), /page_size must be an integer/);
  await assert.rejects(listFolderPageForOwner(`${folder}/../CTO Incoming`, owner, 2, undefined, fakeFetch), /canonical relative/);
  assert.equal(calls, 0, 'invalid paths, cursor scopes, or page sizes do not call Graph');
});

test('Graph nextLink host and path are validated before a cursor is returned', async () => {
  const badLinks = [
    'https://evil.example/v1.0/users/matthew%40innd.com/drive/root:/folder:/children?$skiptoken=x',
    'http://graph.microsoft.com/v1.0/users/matthew%40innd.com/drive/root:/folder:/children?$skiptoken=x',
    'https://graph.microsoft.com/v1.0/users/other%40innd.com/drive/root:/folder:/children?$skiptoken=x',
    'https://graph.microsoft.com/v1.0/users/matthew%40innd.com/drive/root:/different:/children?$skiptoken=x',
    'https://graph.microsoft.com/v1.0/users/matthew%40innd.com/drive/root:/folder:/children?$skiptoken=x&url=https://evil.example',
  ];
  for (const nextLink of badLinks) {
    await assert.rejects(
      listFolderPageForOwner('folder', owner, 2, undefined, async () => response({ value: [], '@odata.nextLink': nextLink })),
      /pagination link outside the requested drive folder/,
    );
  }
});

test('canonical Graph drive/item continuation is accepted only for the response parent IDs', async () => {
  const driveId = 'b!synthetic-drive-id';
  const itemId = 'synthetic-folder-item-id';
  const canonical = `https://graph.microsoft.com/v1.0/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(itemId)}/children?$top=2&$skiptoken=canonical-token`;
  const first = await listFolderPageForOwner(folder, owner, 2, undefined, async () => response({
    value: [{
      name: '001.png',
      id: 'a',
      size: 12,
      parentReference: { driveId, id: itemId },
      file: { hashes: { quickXorHash: 'qx-a' } },
    }],
    '@odata.nextLink': canonical,
  }));
  assert.ok(first.nextCursor);
  let requested = '';
  const second = await listFolderPageForOwner(folder, owner, 2, first.nextCursor!, async (_method, path) => {
    requested = path;
    return response({ value: [{ name: '002.png', parentReference: { driveId, id: itemId } }] });
  });
  assert.equal(requested, canonical);
  assert.equal(second.files[0].name, '002.png');
});

test('cursor signatures prevent edited item IDs or next links from crossing role/path fences', async () => {
  const cursor = await listFolderPageForOwner(folder, owner, 2, undefined, async () => response({ value: [], '@odata.nextLink': pageTwo }));
  assert.ok(cursor.nextCursor);
  const [payload, signature] = cursor.nextCursor!.split('.');
  const tampered = Buffer.from(payload, 'base64url').toString('utf8').replace('opaque-token', 'different-token');
  const forged = `${Buffer.from(tampered).toString('base64url')}.${signature}`;
  let calls = 0;
  await assert.rejects(listFolderPageForOwner(folder, owner, 2, forged, async () => {
    calls++;
    return response({ value: [] });
  }), /Invalid Graph Drive cursor/);
  assert.equal(calls, 0);
});

test('a missing continuation page is an error, not a silent end-of-list', async () => {
  const first = await listFolderPageForOwner(folder, owner, 2, undefined, async () => response({ value: [], '@odata.nextLink': pageTwo }));
  await assert.rejects(
    listFolderPageForOwner(folder, owner, 2, first.nextCursor!, async () => response({}, 404)),
    /continuation page was not found/,
  );
  assert.deepEqual(await listFolderPageForOwner(folder, owner, 2, undefined, async () => response({}, 404)), { files: [], nextCursor: null });
});
