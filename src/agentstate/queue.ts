/**
 * Azure Storage Queue client (dependency-free, account-SAS auth) for the AGENT INBOX.
 *
 * The durable "poke the other agent now" channel that pairs with the Cosmos work-ledger:
 *   ledger  = queryable state-of-record (what is open / claimed / done)
 *   inbox   = delivery (a message waiting for <agent> to pick up on its next turn)
 *
 * One queue per agent: `inbox-<agent>`. agent_dispatch enqueues; inbox_read drains.
 * Inert without creds: if AGENT_INBOX_STORAGE_ACCOUNT/KEY are unset, isConfigured() is false.
 */

import crypto from 'node:crypto';
import { loadEnv } from '../config/env.js';

function creds(): { account: string; key: string } | null {
  const env = loadEnv();
  const account = env.AGENT_INBOX_STORAGE_ACCOUNT;
  const key = env.AGENT_INBOX_STORAGE_KEY;
  if (!account || !key) return null;
  return { account, key };
}

export function isConfigured(): boolean {
  return creds() !== null;
}

/** Account SAS scoped to the QUEUE service (ss=q). Same string-to-sign shape as the blob SAS. */
function buildSas(account: string, key: string, perm = 'racwlup', hours = 1): string {
  const sv = '2021-12-02';
  const ss = 'q';
  const srt = 'sco';
  const st = `${new Date(Date.now() - 5 * 60000).toISOString().slice(0, 19)}Z`;
  const se = `${new Date(Date.now() + hours * 3600 * 1000).toISOString().slice(0, 19)}Z`;
  const sts = `${[account, perm, ss, srt, st, se, '', 'https', sv, ''].join('\n')}\n`;
  const sig = crypto.createHmac('sha256', Buffer.from(key, 'base64')).update(sts, 'utf8').digest('base64');
  return new URLSearchParams({ sv, ss, srt, sp: perm, st, se, spr: 'https', sig }).toString();
}

/** inbox-<agent>, validated to the Azure queue-name rules. */
export function queueName(agent: string): string {
  const a = (agent || '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,40}$/.test(a)) throw new Error(`invalid agent "${agent}"`);
  const name = `inbox-${a.replace(/_/g, '-')}`.replace(/-+/g, '-');
  return name;
}

function base(account: string): string {
  return `https://${account}.queue.core.windows.net`;
}

/** Create the queue if absent (idempotent: 201 created, 204 already exists). */
export async function ensureQueue(agent: string): Promise<void> {
  const c = creds();
  if (!c) throw new Error('agent inbox not configured (AGENT_INBOX_STORAGE_ACCOUNT/KEY unset).');
  const q = queueName(agent);
  const sas = buildSas(c.account, c.key);
  const r = await fetch(`${base(c.account)}/${q}?${sas}`, { method: 'PUT' });
  if (r.status !== 201 && r.status !== 204) {
    throw new Error(`ensureQueue ${q} -> ${r.status}: ${(await r.text()).slice(0, 160)}`);
  }
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export interface InboxMessage {
  to: string;
  from: string;
  subject: string;
  body: string;
  task_id?: string;
  ts: string;
}

/** Enqueue a message to <agent>'s inbox. The payload is base64(JSON) so it is XML-safe. */
export async function enqueue(agent: string, msg: InboxMessage, ttlSeconds = 604800): Promise<void> {
  const c = creds();
  if (!c) throw new Error('agent inbox not configured.');
  await ensureQueue(agent);
  const q = queueName(agent);
  const sas = buildSas(c.account, c.key);
  const payload = Buffer.from(JSON.stringify(msg), 'utf8').toString('base64');
  const bodyXml = `<QueueMessage><MessageText>${xmlEscape(payload)}</MessageText></QueueMessage>`;
  const url = `${base(c.account)}/${q}/messages?messagettl=${ttlSeconds}&${sas}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/xml' },
    body: bodyXml,
  });
  if (r.status !== 201) throw new Error(`enqueue ${q} -> ${r.status}: ${(await r.text()).slice(0, 160)}`);
}

export interface ReadMessage extends InboxMessage {
  message_id: string;
  dequeue_count: number;
  acked: boolean;
}

/**
 * Read up to `max` messages from <agent>'s inbox. When ack=true (default) each read message is
 * deleted (true inbox drain); when ack=false the messages reappear after `visibilitySec`.
 */
export async function readMessages(
  agent: string,
  { max = 16, ack = true, visibilitySec = 60 }: { max?: number; ack?: boolean; visibilitySec?: number } = {},
): Promise<ReadMessage[]> {
  const c = creds();
  if (!c) throw new Error('agent inbox not configured.');
  await ensureQueue(agent);
  const q = queueName(agent);
  const sas = buildSas(c.account, c.key);
  const n = Math.min(32, Math.max(1, max));
  const url = `${base(c.account)}/${q}/messages?numofmessages=${n}&visibilitytimeout=${visibilitySec}&${sas}`;
  const r = await fetch(url, { method: 'GET' });
  if (!r.ok) throw new Error(`inbox read ${q} -> ${r.status}: ${(await r.text()).slice(0, 160)}`);
  const xml = await r.text();
  const out: ReadMessage[] = [];
  for (const block of xml.matchAll(/<QueueMessage>([\s\S]*?)<\/QueueMessage>/g)) {
    const b = block[1];
    const id = (b.match(/<MessageId>([^<]+)<\/MessageId>/) || [])[1] || '';
    const pop = (b.match(/<PopReceipt>([^<]+)<\/PopReceipt>/) || [])[1] || '';
    const dq = Number.parseInt((b.match(/<DequeueCount>([^<]+)<\/DequeueCount>/) || [])[1] || '0', 10);
    const text = (b.match(/<MessageText>([^<]*)<\/MessageText>/) || [])[1] || '';
    let parsed: InboxMessage;
    try {
      parsed = JSON.parse(Buffer.from(text, 'base64').toString('utf8')) as InboxMessage;
    } catch {
      parsed = { to: agent, from: 'unknown', subject: '(unparseable)', body: text, ts: '' };
    }
    let acked = false;
    if (ack && id && pop) {
      const del = await fetch(`${base(c.account)}/${q}/messages/${id}?popreceipt=${encodeURIComponent(pop)}&${sas}`, {
        method: 'DELETE',
      });
      acked = del.status === 204;
    }
    out.push({ ...parsed, message_id: id, dequeue_count: dq, acked });
  }
  return out;
}
