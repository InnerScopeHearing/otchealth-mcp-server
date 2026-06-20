/**
 * kb-memory commons store client.
 *
 * The cross-agent SHARED BRAIN, exposed over MCP. This client is HARDWIRED to the
 * `otchealthcommons` / `company-journal` Azure Blob store and the `_MEMORY/_exec/`
 * shared feed ONLY. It is given no credentials for the cfo (MNPI), clo / clo-personal
 * (privileged), or any PHI store, so it CANNOT read or write those rings by construction.
 * That is the ring guarantee for the gateway: only what an agent explicitly publishes to
 * the shared feed (status / --share, non-sensitive by policy) ever flows through here.
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
  agent: string;
  source?: string;
}

/** Privilege wall: never accept these as a target lane over the gateway. */
const FORBIDDEN_AGENTS = new Set(['clo-personal']);

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
    if (!r.ok) break;
    const xml = await r.text();
    for (const m of xml.matchAll(/<Name>([^<]+)<\/Name>/g)) out.push(m[1]);
    marker = (xml.match(/<NextMarker>([^<]+)<\/NextMarker>/) || [])[1] || '';
  } while (marker);
  return out.filter((n) => n.endsWith('.jsonl'));
}

function sharedKey(agent: string): string {
  return `${SHARED_PREFIX}${agent}.jsonl`;
}

/** Normalize + guard an agent name for the gateway (lowercase; reject privilege-walled lanes). */
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

/** Append an entry to an agent's shared feed (the cross-agent brain). Returns the stored entry. */
export async function appendShared(
  agent: string,
  type: MemoryEntry['type'],
  text: string,
  tags: string[],
  source?: string,
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
  };
  existing.push(entry);
  await putText(sharedKey(a), `${existing.map((r) => JSON.stringify(r)).join('\n')}\n`);
  return entry;
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
