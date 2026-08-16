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

test('chat completions resolve through chatTarget(), not a hard-coded Azure URL built inline in chat()', () => {
  // Mirrors the embeddings test above, for the LLM_PROVIDER escape hatch (src/azure/foundry.ts
  // chat()/chatTarget()). chat() must delegate ALL endpoint/header/model resolution to
  // chatTarget(); a regression that re-inlines the Azure deployment URL construction directly into
  // chat() would silently re-pin every chat caller (llm_azure, checkpoint distillation,
  // claims-check, deep-retrieval plan/refine/synth) to Azure regardless of LLM_PROVIDER.
  const foundry = FILES.find((f) => f.path === 'azure/foundry.ts');
  assert.ok(foundry);
  const chatBody = foundry!.text.split(/export async function chat\(/).slice(1).join('\n');
  assert.match(chatBody, /chatTarget\(/, 'chat() must resolve its endpoint/headers/model through chatTarget()');
  assert.equal(
    /\$\{[^}]+\}\/openai\/deployments\/\$\{[^}]+\}\/chat\/completions/.test(chatBody),
    false,
    'an inline Azure chat-completions URL re-constructed inside chat() re-pins every caller to Azure',
  );
});

test('no file other than azure/foundry.ts builds an Azure chat-completions URL directly', () => {
  // The 5 real chat-completions call sites (llm_azure tool, checkpoint distillation, claims-check,
  // deep-retrieval's plan/refine/synth) must all route through azure/foundry.ts's chat(), the ONLY
  // place LLM_PROVIDER is consulted. A caller that builds its own fetch to an Azure deployment URL
  // would silently bypass the provider switch, exactly the shape of bug this whole file exists to
  // catch (see the file header).
  const offenders = FILES.filter(
    (f) =>
      f.path !== 'azure/foundry.ts' &&
      /\$\{[^}]+\}\/openai\/deployments\/\$\{[^}]+\}\/chat\/completions/.test(f.text),
  ).map((f) => f.path);
  assert.deepEqual(offenders, [], 'route chat completions through azure/foundry.ts chat(), which honours LLM_PROVIDER');
});

test('every real chat() caller imports it from azure/foundry.js, so LLM_PROVIDER actually governs it', () => {
  // Positive assertion (mirrors "the memory write tools go through the dispatcher" above): these
  // are the entire chat-completions surface today. A caller added later that forgets this import
  // could still compile (chat/foundryConfigured/chatConfigured are easy names to reimplement badly
  // by hand) without ever being routed through the provider switch.
  const callers = [
    'tools/llm/azure.ts',
    'tools/memory/checkpoint.ts',
    'tools/safety/claims-check.ts',
    'memory/deep-retrieval.ts',
  ];
  for (const path of callers) {
    const f = FILES.find((x) => x.path === path);
    assert.ok(f, `expected chat() caller missing: ${path}`);
    assert.match(
      f!.text,
      /import \{[^}]*\bchat\b[^}]*\} from '.*azure\/foundry\.js'/,
      `${path} must import chat() from azure/foundry.js to stay governed by LLM_PROVIDER`,
    );
  }
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

/**
 * ===================== ENV-VAR-READ SCAN (2026-08-16) =====================
 *
 * WHY THIS SECTION EXISTS: every check above scans for an IMPORT of a concrete backend module
 * (azure/search-write.js, azure/search.js, search/opensearch.js, ...). src/memory/semantic.ts and
 * src/memory/agentic.ts bypassed the dispatcher WITHOUT importing anything from it or from
 * azure/search.js -- semantic.ts read `e.AZURE_SEARCH_ENDPOINT` off loadEnv()'s return value and
 * agentic.ts read `process.env['AZURE_SEARCH_ENDPOINT']` directly, then each rolled its own
 * fetch() to the Azure REST surface. No import-statement regex can ever see that: there is no
 * import to match. `memory_recall`'s two highest-priority tiers would have gone dark (or badly
 * degraded) the instant SEARCH_BACKEND moved off Azure, and both existing checks above would have
 * stayed green throughout, because neither one looks for this shape of bypass at all.
 *
 * WHAT THIS ADDS: a repo-wide (not tools/*-scoped) scan for a REAL property/bracket read of a
 * backend-selecting env var -- `.AZURE_SEARCH_FOO`, `['AZURE_SEARCH_FOO']`, `["AZURE_SEARCH_FOO"]`
 * -- for every family this file's other checks are already about: AZURE_SEARCH_* (SEARCH_BACKEND),
 * AZURE_BLOB_* (BLOB_BACKEND; not in use in this codebase today, included because it is the exact
 * naming convention azure/search.ts's own comments and this codebase's real AZURE_LEGAL_STORAGE_*
 * pattern would take if it existed), FOUNDRY_* (EMBEDDINGS_PROVIDER / LLM_PROVIDER), and
 * AZURE_OPENAI_* (also not in use today; a common Azure OpenAI naming convention this codebase
 * happens not to use, included defensively so a future file that DOES use it is covered on day one
 * rather than after the next incident). The sibling check for COSMOS_* (STATE_BACKEND) lives in
 * agentstate-dependency-guard.test.ts, this file's counterpart for the state plane -- see that
 * file's own copy of this section for why the split follows each guard's existing theme rather
 * than duplicating the full five-family list in both places.
 *
 * A file's own PROSE can legitimately need to write out `.AZURE_SEARCH_ENDPOINT` or
 * `['AZURE_SEARCH_ENDPOINT']` while describing this exact bug in a comment -- this file's own
 * header above does exactly that, and so do semantic.ts's and agentic.ts's post-fix file headers.
 * The scan therefore runs on COMMENT-STRIPPED text, or every such comment would itself become a
 * false positive and the allow-list would grow without bound for no security reason.
 */

/** Strips /* block *\/ comments and // line comments before the env-var-read scan below runs, so a
 *  file's own prose describing this exact failure class (this file's header, semantic.ts's and
 *  agentic.ts's post-fix headers, ...) cannot trip a check meant to catch a REAL code read.
 *  Deliberately simple -- it does not understand a string literal that itself contains a
 *  comment-like sequence (this codebase's real source never does). The one case it MUST get right,
 *  because this codebase's adapters do it constantly, is that a "//" inside an "https://" URL is
 *  not a line comment: handled by requiring the "//" not be immediately preceded by ':'. Verified
 *  directly below against both a real trailing-slash regex literal (`.replace(/\/+$/, '')`, used
 *  throughout azure/search.ts and azure/foundry.ts) and a real endpoint URL string, so this is not
 *  an untested assumption. */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** Matches a real property/bracket read of one of the four env-var families this file guards.
 *  Deliberately NOT anchored to a specific receiver (`process.env.X`, `e.X`, `env.X`, ...): the
 *  point is to catch the read regardless of which local variable happens to hold loadEnv()'s
 *  result or process.env itself, which a receiver-specific pattern would miss by construction (the
 *  exact failure mode of the import-based checks above). These names are distinctive, all-caps,
 *  underscore-delimited env-var identifiers that do not otherwise occur as object properties in
 *  this codebase, so an unanchored match is not a meaningfully riskier false-positive surface than
 *  an anchored one -- confirmed empirically: this scan produces zero false positives across the
 *  full source tree today (see the two tests below).
 *
 *  DELIBERATELY NO `g` FLAG: every use below is a boolean `.test()` call, never `.matchAll()` or a
 *  loop of `.exec()`. A global-flagged RegExp is STATEFUL -- `.test()` resumes from its own
 *  `lastIndex` on each call and only resets to 0 once a call finds no match -- so reusing one `g`
 *  regex object across many different input strings (as every test below does, checking dozens of
 *  files or synthetic snippets in sequence) would make a call's result depend on what the PREVIOUS
 *  call matched, silently skipping a real violation whenever `lastIndex` from an earlier hit lands
 *  past where the next string's own violation sits. That is exactly the "check looks right but
 *  quietly verifies nothing" failure this whole file exists to prevent, just moved into the guard
 *  itself. Verified directly (node -e), not assumed: with `g` attached, a 4-string sequence where
 *  string 3 matches at a HIGH index (>60) left `lastIndex` past the length of string 4, whose own
 *  violation sits at a LOW index (~11) -- `.test()` on string 4 returned `false`. The identical
 *  sequence with no `g` flag correctly returned `true` for string 4. This is not a hypothetical: it
 *  is precisely the call pattern every test below uses (one shared regex constant, tested against
 *  many different strings in a loop).
 */
const ENV_VAR_READ_RE =
  /\.(AZURE_SEARCH_\w+|AZURE_BLOB_\w+|FOUNDRY_\w+|AZURE_OPENAI_\w+)\b|\[['"](AZURE_SEARCH_\w+|AZURE_BLOB_\w+|FOUNDRY_\w+|AZURE_OPENAI_\w+)['"]\]/;

/** Files allowed to read a search/blob/embeddings/chat backend-selecting env var directly, each
 *  with the reason. Keep this list SMALL -- every new entry is a place SEARCH_BACKEND /
 *  BLOB_BACKEND / EMBEDDINGS_PROVIDER / LLM_PROVIDER cannot reach. */
const ENV_VAR_READ_ALLOWED: Readonly<Record<string, string>> = Object.freeze({
  'azure/search.ts': 'the designated Azure AI Search READ adapter -- src/search/index.ts dispatches to this file when SEARCH_BACKEND=azure',
  'azure/search-write.ts': 'the designated Azure AI Search WRITE adapter -- src/search/index.ts dispatches to this file when SEARCH_BACKEND=azure',
  'azure/foundry.ts': 'the designated Foundry adapter -- embeddingsTarget()/chatTarget() ARE the EMBEDDINGS_PROVIDER/LLM_PROVIDER switch; every other caller reaches Azure OpenAI only through this file',
  'azure/arm-client.ts':
    'Azure Resource Manager CONTROL-PLANE client (search-SERVICE administration: listing/minting admin+query keys, resource-group-scoped operations). Inherently Azure-specific infrastructure management with no SEARCH_BACKEND-equivalent concept -- there is no "AWS ARM" to dispatch to -- so this is a different kind of dependency than the query-time data-path this file otherwise guards, not an unreviewed exception.',
  'server/deep-health.ts':
    'FLAGGED, not endorsed -- outside this fix\'s ownership (src/server/), reported separately rather than fixed here. A deploy-gate live-reachability probe that deliberately reads process.env directly (documented in its own header, for freshness -- loadEnv() caches for the process lifetime) but hardcodes Azure\'s own endpoints regardless of SEARCH_BACKEND/STATE_BACKEND, so post-cutover it will probe dead Azure endpoints instead of the backend actually in use. Allow-listed so this guard stays a true CI gate today; its owner should repoint it at searchConfigured()/hybridSearch() (or an equivalent STATE_BACKEND-aware probe) rather than raw Azure env vars.',
});

test('no file outside the designated adapters reads a search/blob/embeddings/chat backend env var directly', () => {
  // THE ACTUAL FIX FOR THE DEFECT THIS SESSION CLOSED: semantic.ts and agentic.ts used to appear
  // here as offenders (verified below, against their pre-fix source, in the counterfactual test).
  const offenders = FILES.filter((f) => {
    if (f.path in ENV_VAR_READ_ALLOWED) return false;
    return ENV_VAR_READ_RE.test(stripComments(f.text));
  }).map((f) => f.path);

  assert.deepEqual(
    offenders,
    [],
    `These files read a search/blob/embeddings/chat backend-selecting env var directly, bypassing ` +
      `SEARCH_BACKEND / BLOB_BACKEND / EMBEDDINGS_PROVIDER / LLM_PROVIDER even though they import ` +
      `nothing a guard above would catch. Route through src/search/index.ts's dispatcher or ` +
      `azure/foundry.ts's embeddingsTarget()/chatTarget(), or add the file to ENV_VAR_READ_ALLOWED ` +
      `with a reason if it is a genuinely designated adapter.`,
  );
});

test('every env-var-read allow-list exception still exists and still needs its exemption', () => {
  // Mirrors the "cannot rot into a rubber stamp" convention above, for the new allow-list.
  for (const path of Object.keys(ENV_VAR_READ_ALLOWED)) {
    const f = FILES.find((x) => x.path === path);
    assert.ok(f, `allow-listed file no longer exists: ${path} -- remove it from ENV_VAR_READ_ALLOWED`);
    assert.equal(
      ENV_VAR_READ_RE.test(stripComments(f!.text)),
      true,
      `${path} no longer reads a guarded env var directly -- remove its exemption`,
    );
  }
});

test('KNOWN-POSITIVE self-test: the env-var-read scan actually detects a synthetic offender (not just the real tree)', () => {
  // Without this, the regex/allow-list machinery above could be silently loosened to the point of
  // matching nothing, and the "no offenders" assertion would keep passing for the wrong reason --
  // exactly how the pre-fix blind spot survived undetected (see this file's top header). This test
  // proves the DETECTOR still fires, independent of whatever the live source tree happens to
  // contain today.
  const syntheticOffenders = [
    { path: 'fake/dot-access.ts', text: "const ep = e.AZURE_SEARCH_ENDPOINT || '';" },
    { path: 'fake/bracket-single-quote.ts', text: "const key = process.env['AZURE_SEARCH_QUERY_KEY'];" },
    { path: 'fake/bracket-double-quote.ts', text: 'const key = process.env["FOUNDRY_KEY"];' },
    { path: 'fake/blob-family.ts', text: 'const acct = env.AZURE_BLOB_ACCOUNT;' },
    { path: 'fake/openai-family.ts', text: "const k = process.env['AZURE_OPENAI_API_KEY'];" },
  ];
  for (const f of syntheticOffenders) {
    assert.equal(
      ENV_VAR_READ_RE.test(stripComments(f.text)),
      true,
      `detector failed to flag a synthetic offender at ${f.path} -- the scan has been silently weakened`,
    );
  }
});

test('KNOWN-NEGATIVE self-test: a comment merely describing the pattern, and an unrelated env var, are NOT flagged', () => {
  // The other half of the same proof: a detector that flags everything is exactly as useless as one
  // that flags nothing (it gets allow-listed into silence). Confirms stripComments actually does its
  // job, and that the family prefixes do not over-match a superficially similar but unrelated var.
  const syntheticClean = [
    { path: 'fake/doc-comment-dot.ts', text: '// this file used to read e.AZURE_SEARCH_ENDPOINT directly, now it does not\nexport const x = 1;' },
    { path: 'fake/doc-comment-bracket.ts', text: "/* mirrors process.env['AZURE_SEARCH_QUERY_KEY'] from the old code */\nexport const y = 1;" },
    { path: 'fake/url-with-double-slash.ts', text: "const url = 'https://otchealth-foundry.example.invalid/openai/deployments';" },
    { path: 'fake/trailing-slash-regex.ts', text: "const ep = (endpoint || '').replace(/\\/+$/, '');" },
    { path: 'fake/unrelated-storage-var.ts', text: 'const acct = env.AZURE_COMMONS_STORAGE_ACCOUNT;' },
  ];
  for (const f of syntheticClean) {
    assert.equal(
      ENV_VAR_READ_RE.test(stripComments(f.text)),
      false,
      `detector false-positived on a clean file at ${f.path} -- the scan is too broad and will force noisy, meaningless allow-listing`,
    );
  }
});

test('COUNTERFACTUAL: the pre-fix source of semantic.ts and agentic.ts would have been flagged by this scan', () => {
  // Direct proof that this widened guard would have caught the actual defect this session closed,
  // reconstructed from the pre-fix source (git history / this PR's own description) rather than
  // asserted from memory.
  const preFixSemantic = `
    function cfg(): { ep: string; key: string } | null {
      const e = loadEnv();
      const ep = (e.AZURE_SEARCH_ENDPOINT || '').replace(/\\/$/, '');
      const key = e.AZURE_SEARCH_QUERY_KEY || '';
      return ep && key ? { ep, key } : null;
    }
  `;
  const preFixAgentic = `
    function cfg(): { ep: string; key: string } | null {
      const ep = (process.env['AZURE_SEARCH_ENDPOINT'] ?? '').replace(/\\/$/, '');
      const key = process.env['AZURE_SEARCH_QUERY_KEY'] ?? '';
      return ep && key ? { ep, key } : null;
    }
  `;
  assert.equal(ENV_VAR_READ_RE.test(stripComments(preFixSemantic)), true, 'pre-fix semantic.ts must be flagged');
  assert.equal(ENV_VAR_READ_RE.test(stripComments(preFixAgentic)), true, 'pre-fix agentic.ts must be flagged');

  // And the actual post-fix files on disk today must NOT be flagged (neither is allow-listed).
  const semantic = FILES.find((f) => f.path === 'memory/semantic.ts');
  const agentic = FILES.find((f) => f.path === 'memory/agentic.ts');
  assert.ok(semantic && agentic, 'expected memory/semantic.ts and memory/agentic.ts to exist');
  assert.equal(ENV_VAR_READ_RE.test(stripComments(semantic!.text)), false, 'fixed semantic.ts must no longer be flagged');
  assert.equal(ENV_VAR_READ_RE.test(stripComments(agentic!.text)), false, 'fixed agentic.ts must no longer be flagged');
});
