/**
 * kb-memory commons store client.
 *
 * The cross-agent SHARED BRAIN, exposed over MCP. This client is HARDWIRED to the
 * `otchealthcommons` / `company-journal` Azure Blob store and the `_MEMORY/_exec/`
 * shared feed ONLY. It is given no credentials for the cfo (MNPI), clo-personal, or
 * any PHI store, so it CANNOT read or write the actual privileged Azure resources
 * regardless of which agent name is passed -- that isolation is by construction
 * (separate storage accounts/credentials entirely) and is unaffected by the change below.
 *
 * FORMER PRIVILEGE WALL (removed 2026-07-07, CEO directive): "clo-personal" was
 * previously rejected outright as a target lane NAME on this shared feed. Standing
 * directive (Matt/CEO, 2026-07-07): ring-gating/security firewalls between ALL
 * executive agents (cfo, clo, clo-personal, coo, cro, cpo, cco) are SUSPENDED
 * fleet-wide until connectivity/stability is fully dialed in -- prioritize
 * connectivity + performance over security for now. This does NOT touch the
 * separate PHI/MedReview boundary, which remains non-waivable and was never in
 * scope of this directive.
 *
 * Storage layout mirrors skills/kb-memory/mem.mjs exactly:
 *   container: company-journal
 *   shared feed: _MEMORY/_exec/<agent>.jsonl   (one append-only JSONL file per agent)
 * Entries are line-delimited JSON: { id, ts, type, text, tags, agent, source? }.
 *
 * Inert without creds: if AZURE_COMMONS_STORAGE_ACCOUNT/KEY are unset, isConfigured()
 * is false and the tools return a clear "not configured" result instead of throwing.
 */

import crypto from 'node:crypto';
import { loadEnv } from '../config/env.js';

const CONTAINER = 'company-journal';
const SHARED_PREFIX = '_MEMORY/_exec/';

/** A single memory ledger entry (matches the kb-memory JSONL shape). */
export interface MemoryEntry {
  id: string;
  ts: string;
  type: 'fact' | 'decision' | 'correction' | 'pitfall' | 'status';
  text: string;
  tags: string[];
  agent: string; // the TARGET lane whose feed this entry lives on
  source?: string;
  by?: string; // the WRITER (authenticated caller). Absent/=agent => self; !=agent => cross-agent note.
  /**
   * The id of an entry this one REPLACES (a correction chain). Set it when the new entry makes an
   * older one FALSE -- not merely related. Readers (wake's collapseSuperseded, memory_pack) drop
   * the superseded entry so a retracted belief cannot resurface as a live truth. Added 2026-07-13:
   * before this the field did not exist, so the collapse logic could never fire.
   */
  supersedes?: string;
}

/** Privilege wall (EMPTY as of 2026-07-07, CEO directive -- see file header). */
const FORBIDDEN_AGENTS = new Set<string>([]);

function creds(): { account: string; key: string } | null {
  const env = loadEnv();
  const account = env.AZURE_COMMONS_STORAGE_ACCOUNT;
  const key = env.AZURE_COMMONS_STORAGE_KEY;
  if (!account || !key) return null;
  return { account, key };
}

export function isConfigured(): boolean {
  return creds() !== null;
}

/** Account SAS, same construction as kb-memory/doc-indexer (sv 2021-12-02, blob service). */
function buildSas(account: string, key: string, perm = 'rwlc', hours = 1): string {
  const sv = '2021-12-02';
  const ss = 'b';
  const srt = 'co';
  const st = `${new Date(Date.now() - 5 * 60000).toISOString().slice(0, 19)}Z`;
  const se = `${new Date(Date.now() + hours * 3600 * 1000).toISOString().slice(0, 19)}Z`;
  const sts = `${[account, perm, ss, srt, st, se, '', 'https', sv, ''].join('\n')}\n`;
  const sig = crypto.createHmac('sha256', Buffer.from(key, 'base64')).update(sts, 'utf8').digest('base64');
  return new URLSearchParams({ sv, ss, srt, sp: perm, st, se, spr: 'https', sig }).toString();
}

function encPath(name: string): string {
  return name
    .split('/')
    .map((s) => encodeURIComponent(s))
    .join('/');
}

function blobUrl(account: string, sas: string, name: string): string {
  return `https://${account}.blob.core.windows.net/${CONTAINER}/${encPath(name)}?${sas}`;
}

async function getText(name: string): Promise<string | null> {
  const c = creds();
  if (!c) throw new Error('commons store not configured');
  const sas = buildSas(c.account, c.key, 'rl');
  const r = await fetch(blobUrl(c.account, sas, name));
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`commons get ${r.status}`);
  return await r.text();
}

async function putText(name: string, body: string): Promise<void> {
  const c = creds();
  if (!c) throw new Error('commons store not configured');
  const sas = buildSas(c.account, c.key, 'rwlc');
  const r = await fetch(blobUrl(c.account, sas, name), {
    method: 'PUT',
    headers: { 'x-ms-blob-type': 'BlockBlob', 'Content-Type': 'application/x-ndjson' },
    body,
  });
  if (!r.ok) throw new Error(`commons put ${r.status}: ${(await r.text()).slice(0, 160)}`);
}

async function listShared(): Promise<string[]> {
  const c = creds();
  if (!c) throw new Error('commons store not configured');
  const sas = buildSas(c.account, c.key, 'rl');
  const out: string[] = [];
  let marker = '';
  do {
    let u = `https://${c.account}.blob.core.windows.net/${CONTAINER}?restype=container&comp=list&prefix=${encodeURIComponent(SHARED_PREFIX)}&${sas}`;
    if (marker) u += `&marker=${encodeURIComponent(marker)}`;
    const r = await fetch(u);
    // A 404 means the container genuinely does not exist yet -- an empty shared feed is the correct
    // answer. ANY OTHER failure is not: `break` here used to return the accumulator as a normal,
    // successful result, so an expired SAS (these are minted for 1 hour), a rotated storage key, or
    // a transient 5xx produced a confident "no agent has recorded anything" instead of an error.
    //
    // That answer is consumed by memory_team, wake, memory_recall, memory_pack, entity-lookup and
    // the RETRACTION filter -- so the failure mode was an agent starting a session believing the
    // rest of the fleet had recorded nothing, and retracted beliefs resurfacing as current truth.
    // putText() 20 lines above already throws on !r.ok; this is the same store and gets the same
    // treatment. Failing loudly is strictly better than a false empty here.
    if (r.status === 404) break;
    if (!r.ok) {
      throw new Error(
        `commons list ${r.status} (refusing to report an empty shared feed as success): ${(await r.text()).slice(0, 160)}`,
      );
    }
    const xml = await r.text();
    for (const m of xml.matchAll(/<Name>([^<]+)<\/Name>/g)) out.push(m[1]);
    marker = (xml.match(/<NextMarker>([^<]+)<\/NextMarker>/) || [])[1] || '';
  } while (marker);
  return out.filter((n) => n.endsWith('.jsonl'));
}

function sharedKey(agent: string): string {
  return `${SHARED_PREFIX}${agent}.jsonl`;
}

/** Normalize an agent name for the gateway (lowercase, trimmed, shape-validated). */
export function normalizeAgent(agent: string): string {
  const a = (agent || '').trim().toLowerCase();
  if (!a) throw new Error('agent is required');
  if (FORBIDDEN_AGENTS.has(a)) {
    throw new Error(`agent "${a}" is privilege-walled and not accessible over the gateway`);
  }
  if (!/^[a-z0-9][a-z0-9_-]{0,40}$/.test(a)) {
    throw new Error(`invalid agent "${a}" (expected lowercase id, e.g. cto, cfo, haulai)`);
  }
  return a;
}

function parseRows(text: string | null, agent: string): MemoryEntry[] {
  if (!text) return [];
  const rows: MemoryEntry[] = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const r = JSON.parse(t) as MemoryEntry;
      r.agent = r.agent || agent;
      rows.push(r);
    } catch {
      /* skip malformed line */
    }
  }
  return rows;
}

function nextId(rows: MemoryEntry[]): string {
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const n = rows.filter((r) => (r.id || '').startsWith(day)).length + 1;
  return `${day}-${String(n).padStart(3, '0')}`;
}

/** Append an entry to an agent's shared feed (the cross-agent brain). Returns the stored entry.
 * `by` is the authenticated WRITER; when by !== agent this is a CROSS-LANE note (append-only,
 * attributed) that the target sees via memory_inbound and acks via memory_reconcile on wake. */
export async function appendShared(
  agent: string,
  type: MemoryEntry['type'],
  text: string,
  tags: string[],
  source?: string,
  by?: string,
  supersedes?: string,
): Promise<MemoryEntry> {
  const a = normalizeAgent(agent);
  const existing = parseRows(await getText(sharedKey(a)), a);
  const entry: MemoryEntry = {
    id: nextId(existing),
    ts: new Date().toISOString(),
    type,
    text,
    tags,
    agent: a,
    ...(source ? { source } : {}),
    ...(by && by !== a ? { by } : {}),
    ...(supersedes ? { supersedes } : {}),
  };
  existing.push(entry);
  await putText(sharedKey(a), `${existing.map((r) => JSON.stringify(r)).join('\n')}\n`);
  return entry;
}

// ---- Cross-lane INBOUND + wake reconciliation (mirrors skills/kb-memory/mem.mjs) ----
// A per-lane reconcile marker (ISO ts) lives beside the feed as `_MEMORY/_exec/<agent>.reconcile`
// (not a .jsonl, so listShared/readSharedAll never pick it up). Inbound = entries on YOUR feed whose
// `by` is another agent and whose ts is newer than your marker. This is the gateway-side twin of the
// Claude Code wake first-duty, for connected Claude Chat / OS lanes.
function reconcileKey(agent: string): string {
  return `${SHARED_PREFIX}${agent}.reconcile`;
}
export async function readReconcileMarker(agent: string): Promise<string> {
  const a = normalizeAgent(agent);
  const t = await getText(reconcileKey(a));
  return (t || '').trim();
}
export async function writeReconcileMarker(agent: string, iso: string): Promise<void> {
  const a = normalizeAgent(agent);
  await putText(reconcileKey(a), iso);
}
/** Notes OTHER agents wrote on `agent`'s feed since `marker` (or all, if no marker). Oldest first. */
export async function readInbound(agent: string, marker: string): Promise<MemoryEntry[]> {
  const a = normalizeAgent(agent);
  const rows = parseRows(await getText(sharedKey(a)), a);
  return rows
    .filter((r) => r.by && r.by !== a && (!marker || (r.ts || '') > marker))
    .sort((x, y) => (x.ts || '').localeCompare(y.ts || ''));
}

/** Read the whole shared exec feed (every agent), newest first. */
export async function readSharedAll(): Promise<MemoryEntry[]> {
  const blobs = await listShared();
  const all: MemoryEntry[] = [];
  for (const b of blobs) {
    const agent = b.slice(SHARED_PREFIX.length).replace(/\.jsonl$/, '');
    all.push(...parseRows(await getText(b), agent));
  }
  all.sort((x, y) => (y.ts || '').localeCompare(x.ts || ''));
  return all;
}
