import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import {
  GRAPH_CATALOG_CACHE_MAX_ENTRIES,
  GRAPH_CATALOG_CACHE_MAX_IN_FLIGHT,
  GRAPH_CATALOG_CACHE_MAX_SOURCE_BYTES,
  GRAPH_CATALOG_CACHE_MAX_ROWS,
  GRAPH_CATALOG_CACHE_MAX_SHARED_WAITERS,
  readPinnedGraphCatalog,
  type GraphCatalogRawS3,
} from './graph-catalog-reader.js';
const source='a'.repeat(64), createdAt='2026-09-08T00:00:00.000Z';
function harness(text:string, getStatus=200):GraphCatalogRawS3{return async r=>({status:r.method==='HEAD'?200:getStatus,headers:new Headers({etag:'"v1"','content-length':String(Buffer.byteLength(text)),'last-modified':createdAt}),body:r.method==='HEAD'?null:new ReadableStream({start(c){c.enqueue(Buffer.from(text));c.close();}})});}
test('reads bounded JSONL only after a matching pinned HEAD and GET',async()=>{const result=await readPinnedGraphCatalog({key:'graph-trial/catalog.jsonl',sourceSha256:source,createdAt,s3:harness('{"path":"a"}\n')});assert.equal(result.catalogEtag,'"v1"');assert.deepEqual(result.rows,[{path:'a'}]);});
test('fails closed on a changed pinned object or oversized line',async()=>{await assert.rejects(readPinnedGraphCatalog({key:'graph-trial/catalog.jsonl',sourceSha256:source,createdAt,s3:harness('{}\n',412)}),/catalog_changed/);await assert.rejects(readPinnedGraphCatalog({key:'graph-trial/catalog.jsonl',sourceSha256:source,createdAt,s3:harness('x'.repeat(1024*1024+1))}),/catalog_line_too_large/);});


test('rejects impossible HEAD size before GET and rejects truncated or invalid UTF-8',async()=>{
 let requests=0;const s3:GraphCatalogRawS3=async()=>{requests++;return{status:200,headers:new Headers({etag:'"v1"','last-modified':createdAt,'content-length':String(192*1024*1024+1)}),body:null};};
 await assert.rejects(readPinnedGraphCatalog({key:'graph-trial/catalog.jsonl',sourceSha256:source,s3}),/catalog_head_failed/);assert.equal(requests,1);
 const invalid=Buffer.from([0xff]);await assert.rejects(readPinnedGraphCatalog({key:'graph-trial/catalog.jsonl',sourceSha256:source,s3:async r=>({status:200,headers:new Headers({etag:'"v1"','last-modified':createdAt,'content-length':'1'}),body:r.method==='HEAD'?null:new Response(invalid).body})}));
});
test('caller cancellation bounds an unresolved transport without a later GET',async()=>{
 let requests=0;const controller=new AbortController();const pending=readPinnedGraphCatalog({key:'graph-trial/catalog.jsonl',sourceSha256:source,signal:controller.signal,s3:async()=>{requests++;return new Promise(()=>{});}});setTimeout(()=>controller.abort(),5);await assert.rejects(pending,/catalog_cancelled/);assert.equal(requests,1);
});

test('shared catalog download validates content pins independently for each concurrent caller', async () => {
  const text = '{"path":"shared"}\n';
  const actual = createHash('sha256').update(text).digest('hex');
  let releaseGet: (() => void) | undefined;
  const gate = new Promise<void>(resolve => { releaseGet = resolve; });
  const s3: GraphCatalogRawS3 = async request => {
    const headers = new Headers({ etag: '"shared"', 'content-length': String(Buffer.byteLength(text)), 'last-modified': createdAt, 'x-amz-version-id': 'version-1' });
    if (request.method === 'HEAD') return { status: 200, headers, body: null };
    await gate;
    return { status: 200, headers, body: new Response(text).body };
  };
  const leader = readPinnedGraphCatalog({ key: 'graph-trial/shared/catalog.jsonl', sourceSha256: source, s3 });
  await new Promise(resolve => setTimeout(resolve, 0));
  const mismatch = readPinnedGraphCatalog({ key: 'graph-trial/shared/catalog.jsonl', sourceSha256: source, expectedContentSha256: 'b'.repeat(64), s3 });
  releaseGet!();
  const [catalog] = await Promise.all([leader, assert.rejects(mismatch, /catalog_content_changed/)]);
  assert.equal(catalog.catalogContentSha256, actual);
});

test('fresh HEAD coalesces immutable GET and parse work for an unchanged identity', async () => {
  const text = Array.from({ length: 200 }, (_, i) => JSON.stringify({
    path: `finance/row-${i}`,
    nested: { ordinal: i },
  })).join('\n') + '\n';
  let heads = 0;
  let gets = 0;
  let downloaded = 0;
  const s3: GraphCatalogRawS3 = async request => {
    const headers = new Headers({
      etag: '"same"',
      'content-length': String(Buffer.byteLength(text)),
      'last-modified': createdAt,
      'x-amz-version-id': 'version-1',
    });
    if (request.method === 'HEAD') {
      heads++;
      return { status: 200, headers, body: null };
    }
    gets++;
    downloaded += Buffer.byteLength(text);
    return { status: 200, headers, body: new Response(text).body };
  };

  const results = [];
  for (let i = 0; i < 5; i++) {
    results.push(await readPinnedGraphCatalog({
      key: 'graph-trial/synthetic/catalog.jsonl',
      sourceSha256: source,
      s3,
    }));
  }

  assert.deepEqual({ heads, gets, downloaded }, {
    heads: 6,
    gets: 1,
    downloaded: Buffer.byteLength(text),
  });
  assert.equal(results.every(result => result === results[0]), true);
  assert.equal(Object.isFrozen(results[0]), true);
  assert.equal(Object.isFrozen(results[0].rows), true);
  assert.equal(Object.isFrozen(results[0].rows[0]), true);
  assert.equal(Object.isFrozen(results[0].rows[0].nested), true);
  assert.throws(() => {
    (results[0].rows[0] as Record<string, unknown>).path = 'mutated';
  }, TypeError);
});

test('every exact HEAD identity component invalidates the cached catalog immediately', async () => {
  let text = '{"path":"v1"}\n';
  let etag = '"etag-1"';
  let modified = createdAt;
  let versionId = 'version-1';
  let heads = 0;
  let gets = 0;
  const s3: GraphCatalogRawS3 = async request => {
    const headers = new Headers({
      etag,
      'content-length': String(Buffer.byteLength(text)),
      'last-modified': modified,
      'x-amz-version-id': versionId,
    });
    if (request.method === 'HEAD') {
      heads++;
      return { status: 200, headers, body: null };
    }
    gets++;
    return { status: 200, headers, body: new Response(text).body };
  };
  const read = () => readPinnedGraphCatalog({
    key: 'graph-trial/synthetic/identity.jsonl',
    sourceSha256: source,
    s3,
  });

  await read();
  versionId = 'version-2';
  await read();
  modified = '2026-09-08T00:00:01.000Z';
  await read();
  etag = '"etag-2"';
  await read();
  text = '{"path":"version-with-new-size"}\n';
  const changed = await read();

  assert.deepEqual({ heads, gets }, { heads: 10, gets: 5 });
  assert.equal(changed.rows[0].path, 'version-with-new-size');
});

test('a partial stream failure and caller cancellation never publish a cache entry', async () => {
  const text = '{"path":"complete"}\n';
  let gets = 0;
  let failPartial = true;
  let hang = false;
  const s3: GraphCatalogRawS3 = async request => {
    const headers = new Headers({
      etag: '"retryable"',
      'content-length': String(Buffer.byteLength(text)),
      'last-modified': createdAt,
    });
    if (request.method === 'HEAD') return { status: 200, headers, body: null };
    gets++;
    if (failPartial) {
      failPartial = false;
      return {
        status: 200,
        headers,
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(Buffer.from('{"path":'));
            controller.error(new Error('synthetic stream failure'));
          },
        }),
      };
    }
    if (hang) {
      hang = false;
      return {
        status: 200,
        headers,
        body: new ReadableStream({ pull: () => new Promise(() => undefined) }),
      };
    }
    return { status: 200, headers, body: new Response(text).body };
  };
  const input = {
    key: 'graph-trial/synthetic/retry.jsonl',
    sourceSha256: source,
    s3,
  };

  await assert.rejects(readPinnedGraphCatalog(input), /synthetic stream failure/);
  assert.equal((await readPinnedGraphCatalog(input)).rows[0].path, 'complete');
  assert.equal(gets, 2);

  let changedText = '{"path":"after-cancel"}\n';
  const cancellable: GraphCatalogRawS3 = async request => {
    const headers = new Headers({
      etag: '"cancel"',
      'content-length': String(Buffer.byteLength(changedText)),
      'last-modified': createdAt,
    });
    if (request.method === 'HEAD') return { status: 200, headers, body: null };
    gets++;
    if (changedText.includes('after-cancel')) {
      changedText = '{"path":"recovered"}\n';
      return {
        status: 200,
        headers,
        body: new ReadableStream({ pull: () => new Promise(() => undefined) }),
      };
    }
    headers.set('content-length', String(Buffer.byteLength(changedText)));
    return { status: 200, headers, body: new Response(changedText).body };
  };
  const controller = new AbortController();
  const cancelled = readPinnedGraphCatalog({
    key: 'graph-trial/synthetic/cancel.jsonl',
    sourceSha256: source,
    s3: cancellable,
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 5);
  await assert.rejects(cancelled, /catalog_cancelled/);
  const recovered = await readPinnedGraphCatalog({
    key: 'graph-trial/synthetic/cancel.jsonl',
    sourceSha256: source,
    s3: cancellable,
  });
  assert.equal(recovered.rows[0].path, 'recovered');
});

test('concurrent readers perform fresh HEAD checks but coalesce to one bounded GET', async () => {
  const text = '{"path":"coalesced"}\n';
  let heads = 0;
  let gets = 0;
  let release!: () => void;
  const gate = new Promise<void>(resolve => {
    release = resolve;
  });
  const s3: GraphCatalogRawS3 = async request => {
    const headers = new Headers({
      etag: '"coalesced"',
      'content-length': String(Buffer.byteLength(text)),
      'last-modified': createdAt,
    });
    if (request.method === 'HEAD') {
      heads++;
      return { status: 200, headers, body: null };
    }
    gets++;
    await gate;
    return { status: 200, headers, body: new Response(text).body };
  };

  const reads = Array.from({ length: 12 }, () => readPinnedGraphCatalog({
    key: 'graph-trial/synthetic/concurrent.jsonl',
    sourceSha256: source,
    s3,
  }));
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(gets, 1);
  release();
  await Promise.all(reads);
  assert.deepEqual({ heads, gets }, { heads: 13, gets: 1 });
});

test('cache entry and row caps retain bounded state and bypass oversized catalogs', async () => {
  let gets = 0;
  const s3: GraphCatalogRawS3 = async request => {
    const many = request.key.endsWith('many.jsonl');
    const text = many
      ? Array.from({ length: GRAPH_CATALOG_CACHE_MAX_ROWS + 1 }, () => '{}').join('\n') + '\n'
      : JSON.stringify({ path: request.key }) + '\n';
    const headers = new Headers({
      etag: '"bounded"',
      'content-length': String(Buffer.byteLength(text)),
      'last-modified': createdAt,
    });
    if (request.method === 'HEAD') return { status: 200, headers, body: null };
    gets++;
    return { status: 200, headers, body: new Response(text).body };
  };

  const readKey = (key: string) => readPinnedGraphCatalog({ key, sourceSha256: source, s3 });
  for (let i = 0; i <= GRAPH_CATALOG_CACHE_MAX_ENTRIES; i++) {
    await readKey(`graph-trial/synthetic/cache-${i}.jsonl`);
  }
  await readKey('graph-trial/synthetic/cache-0.jsonl');
  assert.equal(gets, GRAPH_CATALOG_CACHE_MAX_ENTRIES + 2);

  const beforeMany = gets;
  await readKey('graph-trial/synthetic/many.jsonl');
  await readKey('graph-trial/synthetic/many.jsonl');
  assert.equal(gets, beforeMany + 2);
});

test('caches a bounded materialized catalog at the CFO backfill scale after a fresh HEAD', async () => {
  const text = Array.from({ length: 47_000 }, (_, ordinal) => JSON.stringify({
    path: `finance/row-${ordinal}`,
    padding: 'x'.repeat(450),
  })).join('\n') + '\n';
  assert.ok(Buffer.byteLength(text) > 20 * 1024 * 1024);
  assert.ok(Buffer.byteLength(text) < GRAPH_CATALOG_CACHE_MAX_SOURCE_BYTES);
  let heads = 0;
  let gets = 0;
  const s3: GraphCatalogRawS3 = async request => {
    const headers = new Headers({
      etag: '"materialized"',
      'content-length': String(Buffer.byteLength(text)),
      'last-modified': createdAt,
      'x-amz-version-id': 'materialized-v1',
    });
    if (request.method === 'HEAD') {
      heads++;
      return { status: 200, headers, body: null };
    }
    gets++;
    return { status: 200, headers, body: new Response(text).body };
  };

  const first = await readPinnedGraphCatalog({
    key: 'graph-trial/synthetic/materialized-scale.jsonl',
    sourceSha256: source,
    expectedVersionId: 'materialized-v1',
    s3,
  });
  const second = await readPinnedGraphCatalog({
    key: 'graph-trial/synthetic/materialized-scale.jsonl',
    sourceSha256: source,
    expectedVersionId: 'materialized-v1',
    s3,
  });

  assert.equal(first, second);
  assert.equal(first.rows.length, 47_000);
  assert.deepEqual({ heads, gets }, { heads: 3, gets: 1 });
});

test('cache entries never cross distinct raw S3 authority adapters', async () => {
  const make = (path: string) => {
    let gets = 0;
    const text = JSON.stringify({ path }) + '\n';
    const s3: GraphCatalogRawS3 = async request => {
      const headers = new Headers({
        etag: '"same-authority-independent-identity"',
        'content-length': String(Buffer.byteLength(text)),
        'last-modified': createdAt,
      });
      if (request.method === 'HEAD') return { status: 200, headers, body: null };
      gets++;
      return { status: 200, headers, body: new Response(text).body };
    };
    return { s3, get gets() { return gets; } };
  };
  const first = make('first');
  const second = make('second');
  const input = { key: 'graph-trial/synthetic/scoped.jsonl', sourceSha256: source };
  assert.equal((await readPinnedGraphCatalog({ ...input, s3: first.s3 })).rows[0].path, 'first');
  assert.equal((await readPinnedGraphCatalog({ ...input, s3: second.s3 })).rows[0].path, 'second');
  assert.deepEqual({ first: first.gets, second: second.gets }, { first: 1, second: 1 });
});

test('distinct cache misses cannot exceed the bounded download concurrency', async () => {
  const maximum = GRAPH_CATALOG_CACHE_MAX_IN_FLIGHT;
  let activeGets = 0;
  let maximumActiveGets = 0;
  let gets = 0;
  let release!: () => void;
  const gate = new Promise<void>(resolve => {
    release = resolve;
  });
  const s3: GraphCatalogRawS3 = async request => {
    const text = JSON.stringify({ path: request.key }) + '\n';
    const headers = new Headers({
      etag: `"${request.key}"`,
      'content-length': String(Buffer.byteLength(text)),
      'last-modified': createdAt,
    });
    if (request.method === 'HEAD') return { status: 200, headers, body: null };
    gets++;
    activeGets++;
    maximumActiveGets = Math.max(maximumActiveGets, activeGets);
    try {
      await gate;
      return { status: 200, headers, body: new Response(text).body };
    } finally {
      activeGets--;
    }
  };

  const reads = Array.from({ length: maximum + 4 }, (_, ordinal) => readPinnedGraphCatalog({
    key: `graph-trial/synthetic/distinct-${ordinal}.jsonl`,
    sourceSha256: source,
    s3,
  }));
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(gets, maximum);
  assert.equal(maximumActiveGets, maximum);
  release();
  await Promise.all(reads);
  assert.equal(gets, maximum + 4);
  assert.equal(maximumActiveGets, maximum);
});

test('GET must still match the exact version and Last-Modified observed by HEAD', async () => {
  const text = '{}\n';
  for (const changed of ['version', 'modified']) {
    const s3: GraphCatalogRawS3 = async request => {
      const headers = new Headers({
        etag: '"same-etag"',
        'content-length': String(Buffer.byteLength(text)),
        'last-modified': request.method === 'GET' && changed === 'modified'
          ? '2026-09-08T00:00:01.000Z'
          : createdAt,
        'x-amz-version-id': request.method === 'GET' && changed === 'version'
          ? 'version-2'
          : 'version-1',
      });
      return {
        status: 200,
        headers,
        body: request.method === 'HEAD' ? null : new Response(text).body,
      };
    };
    await assert.rejects(readPinnedGraphCatalog({
      key: `graph-trial/synthetic/get-changed-${changed}.jsonl`,
      sourceSha256: source,
      s3,
    }), /catalog_changed/);
  }
});

async function cancellationRace(cancelLeader: boolean): Promise<{
  gets: number;
  leader: PromiseSettledResult<unknown>;
  follower: PromiseSettledResult<unknown>;
}> {
  const text = '{"path":"shared-cancellation"}\n';
  let heads = 0;
  let gets = 0;
  let started!: () => void;
  const getStarted = new Promise<void>(resolve => { started = resolve; });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const s3: GraphCatalogRawS3 = async request => {
    const headers = new Headers({
      etag: '"shared-cancellation"',
      'content-length': String(Buffer.byteLength(text)),
      'last-modified': createdAt,
    });
    if (request.method === 'HEAD') {
      heads++;
      return { status: 200, headers, body: null };
    }
    gets++;
    started();
    await gate;
    return { status: 200, headers, body: new Response(text).body };
  };
  const leaderController = new AbortController();
  const followerController = new AbortController();
  const input = {
    key: `graph-trial/synthetic/cancel-${cancelLeader ? 'leader' : 'follower'}.jsonl`,
    sourceSha256: source,
    s3,
  };
  const leader = readPinnedGraphCatalog({ ...input, signal: leaderController.signal });
  await getStarted;
  const follower = readPinnedGraphCatalog({ ...input, signal: followerController.signal });
  while (heads < 2) await new Promise(resolve => setTimeout(resolve, 0));
  await new Promise(resolve => setTimeout(resolve, 5));
  if (cancelLeader) leaderController.abort();
  else followerController.abort();
  release();
  const [leaderResult, followerResult] = await Promise.allSettled([leader, follower]);
  return { gets, leader: leaderResult, follower: followerResult };
}

test('leader cancellation does not cancel a live follower sharing the GET', async () => {
  const result = await cancellationRace(true);
  assert.equal(result.gets, 1);
  assert.equal(result.leader.status, 'rejected');
  assert.match(String((result.leader as PromiseRejectedResult).reason), /catalog_cancelled/);
  assert.equal(result.follower.status, 'fulfilled');
});

test('follower cancellation does not cancel the leader sharing the GET', async () => {
  const result = await cancellationRace(false);
  assert.equal(result.gets, 1);
  assert.equal(result.leader.status, 'fulfilled');
  assert.equal(result.follower.status, 'rejected');
  assert.match(String((result.follower as PromiseRejectedResult).reason), /catalog_cancelled/);
});

test('same-identity followers have an explicit bounded waiter cap', async () => {
  const text = '{"path":"waiter-cap"}\n';
  let gets = 0;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const s3: GraphCatalogRawS3 = async request => {
    const headers = new Headers({
      etag: '"waiter-cap"',
      'content-length': String(Buffer.byteLength(text)),
      'last-modified': createdAt,
    });
    if (request.method === 'HEAD') return { status: 200, headers, body: null };
    gets++;
    await gate;
    return { status: 200, headers, body: new Response(text).body };
  };
  const reads = Array.from(
    { length: GRAPH_CATALOG_CACHE_MAX_SHARED_WAITERS + 1 },
    () => readPinnedGraphCatalog({
      key: 'graph-trial/synthetic/waiter-cap.jsonl',
      sourceSha256: source,
      s3,
    }),
  );
  const settled = Promise.allSettled(reads);
  await new Promise(resolve => setTimeout(resolve, 10));
  release();
  const outcomes = await settled;
  assert.equal(gets, 1);
  assert.equal(outcomes.filter(value => value.status === 'fulfilled').length, GRAPH_CATALOG_CACHE_MAX_SHARED_WAITERS);
  const rejected = outcomes.filter(value => value.status === 'rejected') as PromiseRejectedResult[];
  assert.equal(rejected.length, 1);
  assert.match(String(rejected[0].reason), /catalog_reader_busy/);
});

test('early GET identity rejection bounded-cancels an unread response body', async () => {
  const text = '{}\n';
  let cancelCalls = 0;
  const s3: GraphCatalogRawS3 = async request => {
    const headers = new Headers({
      etag: '"body-mismatch"',
      'content-length': String(Buffer.byteLength(text)),
      'last-modified': request.method === 'HEAD'
        ? createdAt
        : '2026-09-08T00:00:01.000Z',
    });
    return {
      status: 200,
      headers,
      body: request.method === 'HEAD'
        ? null
        : new ReadableStream({
            cancel() {
              cancelCalls++;
              return new Promise(() => undefined);
            },
          }),
    };
  };
  const started = Date.now();
  await assert.rejects(readPinnedGraphCatalog({
    key: 'graph-trial/synthetic/unread-mismatch.jsonl',
    sourceSha256: source,
    s3,
  }), /catalog_changed/);
  assert.equal(cancelCalls, 1);
  assert.ok(Date.now() - started < 1000, 'hung stream cancellation must remain bounded');
});
