import { createHistoricalRelationshipReader } from "./historical-reader.mjs";
import { createCrossRunRecall } from "./cross-run-recall.mjs";
import { createHash } from "node:crypto";
import { RELATIONSHIP_ARTIFACT_BUCKET } from "./historical-reader.mjs";

const MAX_PAGE = 64;
const MAX_RESPONSE = 512 * 1024;
const TIMEOUT_MS = 30_000;
const RUN = /^run_[a-f0-9]{64}$/;
const PRODUCER = /^[a-z][a-z0-9-]{0,63}$/;
const HASH = /^[a-f0-9]{64}$/;
const fail = code => { throw Object.assign(new Error(code), { code }); };
const exact = (value, keys) => !!value && Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
const clone = value => { try { return structuredClone(value); } catch { fail("paged_recall_invalid"); } };
const canonical = value => value === null || typeof value !== "object" ? JSON.stringify(value) : Array.isArray(value) ? `[${value.map(canonical).join(",")}]` : `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
const sha256 = value => createHash("sha256").update(value).digest("hex");
function origin(value) { let url; try { url = new URL(value); } catch { fail("paged_recall_configuration"); }
  if (url.protocol !== "https:" || !url.hostname || url.port || url.username || url.password || url.pathname !== "/" || url.search || url.hash) fail("paged_recall_configuration"); return url.origin; }
function active(signal) { if (signal?.aborted) fail("paged_recall_deadline"); }
async function deadline(signal, work) {
  active(signal); const controller = new AbortController(), timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const aborted = new Promise((_, reject) => combined.addEventListener("abort", () => reject(Object.assign(new Error("paged_recall_deadline"), { code: "paged_recall_deadline" })), { once: true }));
  try { return await Promise.race([Promise.resolve(work(combined)), aborted]); }
  finally { clearTimeout(timer); controller.abort(); }
}
async function body(response, signal) {
  const size = response.headers?.get?.("content-length"), declared = size === null ? null : Number(size);
  if (declared !== null && (!Number.isSafeInteger(declared) || declared < 0 || declared > MAX_RESPONSE)) fail("paged_recall_response_invalid");
  const reader = response.body?.getReader?.(); if (!reader) { const bytes = Buffer.from(await response.arrayBuffer()); if (bytes.length > MAX_RESPONSE || (declared !== null && bytes.length !== declared)) fail("paged_recall_response_too_large"); return bytes; }
  const chunks = []; let length = 0;
  try { for (;;) { const next = await deadline(signal, () => reader.read()); if (next.done) break; length += next.value.byteLength; if (length > MAX_RESPONSE) { await Promise.race([reader.cancel().catch(() => {}), new Promise(resolve => setTimeout(resolve, 100))]); fail("paged_recall_response_too_large"); } chunks.push(Buffer.from(next.value)); } }
  catch (error) { await Promise.race([reader.cancel().catch(() => {}), new Promise(resolve => setTimeout(resolve, 100))]); throw error; }
  if (declared !== null && declared !== length) fail("paged_recall_response_invalid"); return Buffer.concat(chunks, length);
}
function ref(value) {
  if (!exact(value, ["artifact_id", "bucket", "key", "payload_sha256", "schema", "size_bytes", "version_id"]) || value.schema !== "relationship-resolution-artifact-ref-v1" ||
      !HASH.test(value.payload_sha256 || "") || value.artifact_id !== `resart_${value.payload_sha256}` || value.bucket !== RELATIONSHIP_ARTIFACT_BUCKET ||
      value.key !== `resolution-artifacts/sha256/${value.payload_sha256.slice(0, 2)}/${value.payload_sha256}.json` || typeof value.version_id !== "string" || !/^[^\s\p{C}]{1,1024}$/u.test(value.version_id) || value.version_id === "null" || !Number.isSafeInteger(value.size_bytes) || value.size_bytes < 0 || value.size_bytes > 16 * 1024 * 1024) fail("paged_recall_publication_invalid");
  return clone(value);
}
function run(value) { if (!exact(value, ["ref_version", "run_id", "purpose", "scope", "run_version", "manifest_sha256"]) || value.ref_version !== "neptune-trial-active-run-ref-v1" || !RUN.test(value.run_id || "") || value.scope !== "finance" || !HASH.test(value.manifest_sha256 || "") || !/^[a-z0-9][a-z0-9_.:-]{0,95}$/.test(value.purpose || "") || !/^[a-z0-9][a-z0-9_.:-]{0,95}$/.test(value.run_version || "") || value.run_id !== `run_${sha256(canonical({ ref_version: value.ref_version, purpose: value.purpose, scope: value.scope, run_version: value.run_version, manifest_sha256: value.manifest_sha256 }))}`) fail("paged_recall_publication_invalid"); return clone(value); }
function after(value) { if (value !== null && value !== undefined && !RUN.test(value)) fail("paged_recall_cursor_invalid"); return value ?? null; }
function page(value, expectedAfter, producer, limit) {
  if (!exact(value, ["schema", "items", "next_after"]) || value.schema !== "relationship-publication-page-v1" || !Array.isArray(value.items) || value.items.length > MAX_PAGE ||
      value.items.length > limit || (value.next_after !== null && !RUN.test(value.next_after))) fail("paged_recall_page_invalid");
  let prior = expectedAfter;
  const items = value.items.map(item => {
    if (!exact(item, ["run", "producer_id", "artifact_ref"]) || item.producer_id !== producer) fail("paged_recall_page_invalid");
    const entry = { run: run(item.run), producer_id: item.producer_id, artifact_ref: ref(item.artifact_ref) };
    if (prior !== null && entry.run.run_id <= prior) fail("paged_recall_page_invalid"); prior = entry.run.run_id; return entry;
  });
  if (value.next_after !== null && (!items.length || value.next_after !== items.at(-1).run.run_id)) fail("paged_recall_page_invalid");
  return Object.freeze({ schema: value.schema, items: Object.freeze(items), next_after: value.next_after });
}

export function createPagedRecallHost({ gatewayOrigin, cohortId, producer, historyTrust, sse, getAuthorization, fetchImpl,
  createResolver, bindPreparedSource, verificationRequestHash, now = Date.now } = {}) {
  const fixedOrigin = origin(gatewayOrigin);
  if (typeof cohortId !== "string" || !/^[a-z][a-z0-9-]{0,95}$/.test(cohortId) || !PRODUCER.test(producer || "") || !historyTrust || !sse ||
      typeof getAuthorization !== "function" || typeof fetchImpl !== "function" || typeof createResolver !== "function" || typeof bindPreparedSource !== "function" ||
      typeof verificationRequestHash !== "function" || typeof now !== "function") fail("paged_recall_configuration");
  const base = `${fixedOrigin}/relationship-publications/v1/${encodeURIComponent(cohortId)}/${encodeURIComponent(producer)}`;
  async function authorization(signal) {
    let token; try { token = await deadline(signal, requestSignal => getAuthorization(Object.freeze({ cohort_id: cohortId, producer_id: producer, caller_seat: "cfo" }), { signal: requestSignal })); }
    catch (error) { if (error?.code === "paged_recall_deadline") throw error; fail("paged_recall_auth_failed"); }
    if (typeof token !== "string" || !/^Bearer [^\s]{16,8192}$/.test(token)) fail("paged_recall_auth_failed"); return token;
  }
  async function request(url, method, payload, signal) {
    const token = await authorization(signal); let bytes;
    try { bytes = await deadline(signal, async requestSignal => { const reply = await fetchImpl(url, { method, headers: Object.freeze({ authorization: token, ...(payload === null ? {} : { "content-type": "application/json" }) }), body: payload === null ? undefined : JSON.stringify(payload), signal: requestSignal, redirect: "error" }); return { reply, bytes: await body(reply, requestSignal) }; }); }
    catch (error) { if (error?.code === "paged_recall_deadline" || error?.name === "AbortError") fail("paged_recall_deadline"); fail("paged_recall_transport_unknown"); }
    if (bytes.reply.status === 401 || bytes.reply.status === 403) fail("paged_recall_forbidden"); if (bytes.reply.status < 200 || bytes.reply.status > 299) fail("paged_recall_unavailable");
    if (!Buffer.from(bytes.bytes.toString("utf8"), "utf8").equals(bytes.bytes)) fail("paged_recall_response_invalid"); try { return JSON.parse(bytes.bytes.toString("utf8")); } catch { fail("paged_recall_response_invalid"); }
  }
  function publicationReader(item) {
    return createHistoricalRelationshipReader({ gatewayOrigin: fixedOrigin, run: item.run, producer, historyTrust, getAuthorization, now, sse,
      fetchImpl: async (oldUrl, init) => {
        const source = new URL(oldUrl); const expected = new RegExp(`^/relationship-history/v1/${item.run.run_id}/${producer}/sha256/([a-f0-9]{2})/([a-f0-9]{64})\\.json$`).exec(source.pathname);
        if (source.origin !== fixedOrigin || !expected || expected[1] !== expected[2].slice(0, 2) || source.searchParams.get("versionId") === null || [...source.searchParams.keys()].length !== 1) fail("paged_recall_reader_route_invalid");
        const target = `${base}/artifacts/${item.run.run_id}/sha256/${expected[1]}/${expected[2]}.json?versionId=${encodeURIComponent(source.searchParams.get("versionId"))}`;
        return fetchImpl(target, init);
      } });
  }
  async function listPage({ after: rawAfter = null, limit = MAX_PAGE, signal } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE) fail("paged_recall_limit_invalid"); const cursor = after(rawAfter);
    const url = `${base}?limit=${limit}${cursor ? `&after=${encodeURIComponent(cursor)}` : ""}`;
    return page(await request(url, "GET", null, signal), cursor, producer, limit);
  }
  return Object.freeze({
    async publish({ run: rawRun, artifact_ref }, { signal } = {}) {
      const result = await request(base, "POST", { run: run(rawRun), artifact_ref: ref(artifact_ref) }, signal);
      if (!exact(result, ["schema", "item"]) || result.schema !== "relationship-publication-receipt-v1") fail("paged_recall_response_invalid");
      const receipt = frozenPublication(result.item, producer);
      if (canonical(receipt.run) !== canonical(run(rawRun)) || canonical(receipt.artifact_ref) !== canonical(ref(artifact_ref))) fail("paged_recall_response_invalid");
      return receipt;
    },
    list: listPage,
    async retrievePage(query, { after: rawAfter = null, limit = MAX_PAGE, signal } = {}) {
      const result = await listPage({ after: rawAfter, limit, signal });
      const recall = createCrossRunRecall({ createResolver, bindPreparedSource, verificationRequestHash, readers: result.items.map(publicationReader), now });
      return Object.freeze({ recall: await recall.recall({ histories: result.items, query: clone(query) }, { signal }), page: result });
    },
  });
}
function frozenPublication(item, producer) {
  if (!exact(item, ["run", "producer_id", "artifact_ref"]) || item.producer_id !== producer) fail("paged_recall_response_invalid");
  return Object.freeze({ run: run(item.run), producer_id: item.producer_id, artifact_ref: ref(item.artifact_ref) });
}
