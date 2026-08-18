import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// The commons store is inert without creds, so set them BEFORE importing (loadEnv caches).
process.env.CIO_SITE_ID ||= 'test';
process.env.CIO_TRACK_KEY ||= 'test';
process.env.CIO_APP_API_BEARER ||= 'test';
process.env.PERPLEXITY_CONNECTOR_TOKEN ||= 'x'.repeat(32);
process.env.ADMIN_REVOKE_TOKEN ||= 'x'.repeat(32);
process.env.N8N_WEBHOOK_SECRET ||= 'x'.repeat(32);
process.env.AZURE_COMMONS_STORAGE_ACCOUNT ||= 'teststore';
process.env.AZURE_COMMONS_STORAGE_KEY ||= Buffer.from('k'.repeat(32)).toString('base64');

// BLOB_BACKEND is deliberately left UNSET, so this file exercises the Azure path. The S3 path has
// its own file (store-s3.test.ts) because loadEnv() caches and each test file gets its own process.
delete process.env.BLOB_BACKEND;

const { normalizeAgent, readSharedAll, appendShared, isConfigured } = await import('./store.js');

async function withFetch<T>(stub: typeof fetch, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

// ── The shared feed must never report a FAILURE as an empty feed ────────────────────────────────
// listShared() used a bare `if (!r.ok) break;`, returning its accumulator as a normal success. An
// expired SAS (minted for 1 hour), a rotated storage key, or a transient 5xx therefore produced a
// confident "no agent has recorded anything".
//
// That answer feeds memory_team, wake, memory_recall, memory_pack, entity-lookup AND the retraction
// filter -- so the real consequences were (a) an agent starting a session believing the fleet had
// recorded nothing, and (b) retracted beliefs resurfacing through brain_search as current truth,
// because the retraction set had silently been emptied.
describe('memory store shared-feed listing: a failure is an error, never an empty feed', () => {
  it('THROWS on a 403 (expired SAS / rotated key) instead of returning an empty feed', async () => {
    await withFetch(
      (async () => new Response('AuthenticationFailed', { status: 403 })) as unknown as typeof fetch,
      async () => {
        await assert.rejects(() => readSharedAll(), /commons list 403/);
      },
    );
  });

  it('THROWS on a 500, rather than silently truncating', async () => {
    await withFetch(
      (async () => new Response('oops', { status: 500 })) as unknown as typeof fetch,
      async () => {
        await assert.rejects(() => readSharedAll(), /commons list 500/);
      },
    );
  });

  it('treats 404 as a genuinely absent container -> empty, no error', async () => {
    // This is the ONE case where empty is the honest answer: the container does not exist yet.
    await withFetch(
      (async () => new Response('ContainerNotFound', { status: 404 })) as unknown as typeof fetch,
      async () => {
        assert.deepEqual(await readSharedAll(), []);
      },
    );
  });

  it('a mid-pagination failure throws rather than returning a PARTIAL feed as complete', async () => {
    // Page 1 succeeds and carries a NextMarker; page 2 fails. Returning page 1 alone would look
    // like a complete feed and silently hide every entry after it.
    let call = 0;
    await withFetch(
      (async () => {
        call += 1;
        if (call === 1) {
          return new Response(
            '<EnumerationResults><Name>shared/cto.jsonl</Name><NextMarker>m2</NextMarker></EnumerationResults>',
            { status: 200 },
          );
        }
        return new Response('throttled', { status: 503 });
      }) as unknown as typeof fetch,
      async () => {
        await assert.rejects(() => readSharedAll(), /commons list 503/);
      },
    );
    assert.equal(call >= 2, true, 'expected pagination to have attempted the second page');
  });
});

// ── The Azure path is a ROLLBACK, so it has to keep working (2026-08-18) ─────────────────────────
// The S3 branch added to getText/putText/listShared is behind a BLOB_BACKEND selector precisely so
// the Azure path survives as the rollback. A selector whose "off" position quietly broke would be
// no better than deleting the Azure code, and worse than leaving it alone: it would look reversible.
describe('memory store on the DEFAULT (Azure) backend, with BLOB_BACKEND unset', () => {
  it('still writes to Azure Blob, and to no S3 bucket', async () => {
    const seen: Array<{ url: string; method: string }> = [];
    await withFetch(
      (async (u: string | URL | Request, init?: RequestInit) => {
        seen.push({ url: String(u), method: init?.method ?? 'GET' });
        if ((init?.method ?? 'GET') === 'PUT') return new Response('', { status: 201 });
        return new Response('', { status: 404 }); // no existing feed
      }) as unknown as typeof fetch,
      async () => {
        const entry = await appendShared('cto', 'fact', 'azure rollback path', ['t']);
        assert.equal(entry.text, 'azure rollback path');
      },
    );
    const put = seen.find((s) => s.method === 'PUT');
    assert.ok(put, 'the Azure PUT must still be issued');
    assert.match(put!.url, /teststore\.blob\.core\.windows\.net\/company-journal\/_MEMORY\/_exec\/cto\.jsonl/);
    assert.equal(
      seen.some((s) => s.url.includes('amazonaws.com')),
      false,
      'with BLOB_BACKEND unset nothing may reach S3',
    );
  });

  it('still reports configured from the Azure credentials alone', () => {
    assert.equal(isConfigured(), true);
  });

  it('still THROWS on a failed Azure write rather than returning an unpersisted entry', async () => {
    await withFetch(
      (async (_u: string, init?: RequestInit) =>
        (init?.method ?? 'GET') === 'PUT'
          ? new Response('AuthenticationFailed', { status: 403 })
          : new Response('', { status: 404 })) as unknown as typeof fetch,
      async () => {
        await assert.rejects(() => appendShared('cto', 'fact', 'x', []), /commons put 403/);
      },
    );
  });
});

// Pure, no-network. normalizeAgent is the shape guard for the gateway memory surface.
describe('memory store normalizeAgent', () => {
  it('lowercases and trims a valid agent id', () => {
    assert.equal(normalizeAgent('CTO'), 'cto');
    assert.equal(normalizeAgent('  Haulai '), 'haulai');
    assert.equal(normalizeAgent('commerce'), 'commerce');
    assert.equal(normalizeAgent('clo'), 'clo');
  });

  it('ACCEPTS clo-personal (2026-07-07: privilege wall lifted per standing CEO directive)', () => {
    assert.equal(normalizeAgent('clo-personal'), 'clo-personal');
    assert.equal(normalizeAgent('CLO-Personal'), 'clo-personal');
  });

  it('rejects empty / invalid ids', () => {
    assert.throws(() => normalizeAgent(''), /required/);
    assert.throws(() => normalizeAgent('bad name!'), /invalid agent/);
    assert.throws(() => normalizeAgent('a/b'), /invalid agent/);
    assert.throws(() => normalizeAgent('x'.repeat(60)), /invalid agent/);
  });
});
