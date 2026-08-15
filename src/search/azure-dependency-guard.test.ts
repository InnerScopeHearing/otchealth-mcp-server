import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * ARCHITECTURE GUARD — the CI gate for the failure class that nearly broke the AWS cutover.
 *
 * On 2026-08-15 the same defect was found FOUR separate times in one day:
 *   - the search backend moved to OpenSearch, but every memory WRITE still went to Azure
 *   - the documents were mirrored to S3, but blob-store.ts had no S3 read path at all
 *   - query embeddings still went to Azure Foundry
 *   - Azure Search writes could not authenticate from AWS, making rollback one-way
 *
 * Every one had the same shape: the DATA moved, the CODE kept pointing at Azure, and nothing
 * failed loudly enough to notice. Each was invisible in review because the offending line is a
 * plain, correct-looking import.
 *
 * These tests read the actual source tree and fail if a path that has been migrated regains a
 * direct Azure dependency. They are deliberately structural rather than behavioural: a behavioural
 * test only catches the regression once someone runs that code path against a dead Azure, which
 * during a migration is far too late.
 *
 * If a change here fails, the fix is almost never to edit this file. It is to route the new code
 * through the dispatcher (src/search/index.ts, src/legal/blob-store.ts, embeddingsTarget) so it
 * honours SEARCH_BACKEND / BLOB_BACKEND / EMBEDDINGS_PROVIDER like everything else.
 */

const SRC = new URL('..', import.meta.url).pathname;

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      sourceFiles(full, out);
    } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out;
}

const FILES = sourceFiles(SRC).map((f) => ({ path: relative(SRC, f), text: readFileSync(f, 'utf8') }));

/** Files allowed to import the Azure writer directly, with the reason each one is legitimate. */
const AZURE_WRITE_ALLOWED: Readonly<Record<string, string>> = Object.freeze({
  'search/index.ts': 'the dispatcher itself: it must reach both backends to route between them',
  'search/opensearch-write.ts': 'reuses memoryDocId + the IndexResult type so both backends agree on doc identity',
  'tools/legal/blob-move.ts': 'de-index of Azure chunked doc rooms, not a memory write',
  'tools/legal/blob-delete.ts': 'de-index of Azure chunked doc rooms, not a memory write',
  'agentstate/deindex-resweep.ts': 'de-index resweep of Azure chunked doc rooms, not a memory write',
});

test('THE SHOWSTOPPER: no memory write may import the Azure writer directly', () => {
  // This is the exact regression that would have produced fleet-wide amnesia on cutover: reads
  // resolving against OpenSearch while writes silently landed in Azure.
  const offenders = FILES.filter(
    (f) => /from '.*azure\/search-write\.js'/.test(f.text) && !(f.path in AZURE_WRITE_ALLOWED),
  ).map((f) => f.path);

  assert.deepEqual(
    offenders,
    [],
    `These files import the Azure-only writer directly. Route memory writes through ` +
      `indexMemory() in src/search/index.ts so they honour SEARCH_BACKEND, or add the file to ` +
      `AZURE_WRITE_ALLOWED with a reason if it is genuinely an Azure-specific de-index path.`,
  );
});

test('every allow-listed exception still exists, so the list cannot rot into a rubber stamp', () => {
  // An allow-list that accumulates dead entries stops meaning anything. If a file was deleted or
  // renamed, its exemption must go with it rather than silently pre-authorising a future file at
  // that path.
  for (const path of Object.keys(AZURE_WRITE_ALLOWED)) {
    const f = FILES.find((x) => x.path === path);
    assert.ok(f, `allow-listed file no longer exists: ${path} -- remove it from AZURE_WRITE_ALLOWED`);
    assert.ok(
      /from '.*azure\/search-write\.js'/.test(f!.text),
      `${path} no longer imports the Azure writer -- remove its exemption`,
    );
  }
});

test('the memory write tools go through the dispatcher, not a backend', () => {
  // Positive assertion, not just absence: these five are the entire memory write surface, and each
  // must reach indexMemory so dual-write and backend selection actually apply to it.
  const writers = [
    'tools/agentstate/memory-write.ts',
    'tools/memory/remember.ts',
    'tools/memory/checkpoint.ts',
    'safety/journal.ts',
    'safety/shadow-eval.ts',
  ];
  for (const path of writers) {
    const f = FILES.find((x) => x.path === path);
    assert.ok(f, `expected memory writer missing: ${path}`);
    assert.match(
      f!.text,
      /import \{ indexMemory as indexMemoryNow \} from '.*search\/index\.js'/,
      `${path} must write through the dispatcher, or its memories vanish on the non-active backend`,
    );
  }
});

test('document reads dispatch on BLOB_BACKEND rather than hard-calling Azure Blob', () => {
  const blobStore = FILES.find((f) => f.path === 'legal/blob-store.ts');
  assert.ok(blobStore);
  assert.match(
    blobStore!.text,
    /s3BlobBackendActive\(\)/,
    'blob-store must consult BLOB_BACKEND, or documents keep coming from Azure after cutover',
  );
});

test('query embeddings resolve through the provider, not a hard-coded Azure URL', () => {
  const foundry = FILES.find((f) => f.path === 'azure/foundry.ts');
  assert.ok(foundry);
  // embed()/embedBatch() must call embeddingsTarget(); a reintroduced literal deployment URL in
  // either would quietly pin queries back to Azure.
  const embedBodies = foundry!.text.split(/export async function embed/).slice(1).join('\n');
  assert.match(embedBodies, /embeddingsTarget\(\)/, 'embed paths must resolve the provider');
  assert.equal(
    /openai\/deployments\/\$\{c\.embed\}/.test(embedBodies),
    false,
    'an inline Azure deployment URL in embed() re-pins queries to Azure',
  );
});

test('the pinned embedding model is not silently made configurable', () => {
  // Query vectors must come from the SAME model the 492,557 indexed vectors were built with.
  // A configurable model reads as flexibility and behaves as a silent relevance collapse.
  const foundry = FILES.find((f) => f.path === 'azure/foundry.ts');
  assert.match(foundry!.text, /model: 'text-embedding-3-large'/, 'the OpenAI path must pin the model');
});

test('no migrated path sends a dimensions parameter to an embeddings API', () => {
  // Truncates the vector into a space the index does not share -- same failure as the wrong model.
  const offenders = FILES.filter((f) => /\bdimensions\s*:/.test(f.text) && /embeddings/.test(f.text)).map((f) => f.path);
  assert.deepEqual(offenders, [], 'a dimensions parameter would break comparability with the index');
});

test('the backends stay behind the dispatcher: no tool imports a concrete search backend', () => {
  // A tool importing azure/search.js or search/opensearch.js directly bypasses SEARCH_BACKEND, so
  // it would keep querying one engine while the rest of the gateway moved to the other.
  const offenders = FILES.filter(
    (f) =>
      f.path.startsWith('tools/') &&
      /from '.*(azure\/search\.js|search\/opensearch\.js)'/.test(f.text),
  ).map((f) => f.path);
  assert.deepEqual(offenders, [], 'tools must import from src/search/index.js (the dispatcher)');
});
