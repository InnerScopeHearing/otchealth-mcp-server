/**
 * Agent-state backend dispatcher.
 *
 * Every consumer of the state plane imports from HERE, never from cosmos.ts or postgres.ts
 * directly, so which store is live is decided in exactly one place by STATE_BACKEND.
 *
 * This mirrors src/search/index.ts, and for a reason worth restating: on 2026-08-15 four separate
 * cutover defects all had the same shape -- the data had moved, one code path had not, and the
 * result was a plausible payload rather than an error. Each offending line was an ordinary,
 * correct-looking import. A dispatcher plus a CI guard that forbids importing past it is what
 * makes that class of mistake impossible to land rather than merely unlikely.
 *
 * ROLLBACK
 * Flipping STATE_BACKEND back to 'cosmos' must actually work, so neither backend may be deleted
 * while the other is live, and both must remain reachable from the runtime that runs them. The
 * equivalent property was already violated once on the search side: Azure Search writes
 * authenticate via a managed identity that exists only inside Azure, so from AWS the rollback was
 * one-way until an explicit key escape hatch was added. Postgres has no such asymmetry -- it is
 * reachable from anywhere in the VPC with a password -- but Cosmos retains its, so a rollback is
 * only genuinely available while the gateway can still mint an Azure credential.
 */

import { loadEnv } from '../config/env.js';
import * as cosmos from './cosmos.js';
import * as postgres from './postgres.js';

export type StateBackend = 'cosmos' | 'postgres';

export function activeBackend(): StateBackend {
  return loadEnv().STATE_BACKEND;
}

/** True when the ACTIVE backend is usable. A configured-but-inactive backend does not count. */
export function isConfigured(): boolean {
  return activeBackend() === 'postgres' ? postgres.isConfigured() : cosmos.isConfigured();
}

export async function createDoc(coll: string, pkValue: string, doc: Record<string, unknown>) {
  return activeBackend() === 'postgres' ? postgres.createDoc(coll, pkValue, doc) : cosmos.createDoc(coll, pkValue, doc);
}

export async function readDoc(coll: string, pkValue: string, id: string) {
  return activeBackend() === 'postgres' ? postgres.readDoc(coll, pkValue, id) : cosmos.readDoc(coll, pkValue, id);
}

export async function replaceDoc(
  coll: string,
  pkValue: string,
  id: string,
  doc: Record<string, unknown>,
  ifMatch?: string,
) {
  return activeBackend() === 'postgres'
    ? postgres.replaceDoc(coll, pkValue, id, doc, ifMatch)
    : cosmos.replaceDoc(coll, pkValue, id, doc, ifMatch);
}

export async function deleteDoc(coll: string, pkValue: string, id: string, ifMatch?: string) {
  return activeBackend() === 'postgres'
    ? postgres.deleteDoc(coll, pkValue, id, ifMatch)
    : cosmos.deleteDoc(coll, pkValue, id, ifMatch);
}

export async function upsertDoc(coll: string, pkValue: string, doc: Record<string, unknown>) {
  return activeBackend() === 'postgres' ? postgres.upsertDoc(coll, pkValue, doc) : cosmos.upsertDoc(coll, pkValue, doc);
}

export async function queryDocs(
  coll: string,
  query: string,
  parameters: { name: string; value: unknown }[] = [],
  opts: { pk?: string; max?: number } = {},
): Promise<Record<string, unknown>[]> {
  return activeBackend() === 'postgres'
    ? postgres.queryDocs(coll, query, parameters, opts)
    : cosmos.queryDocs(coll, query, parameters, opts);
}

export interface VectorMatch {
  doc: Record<string, unknown>;
  similarity: number;
}

export async function vectorSearchDocs(
  coll: string,
  pkValue: string,
  vectorField: string,
  vector: number[],
  top = 1,
): Promise<VectorMatch[]> {
  return activeBackend() === 'postgres'
    ? postgres.vectorSearchDocs(coll, pkValue, vectorField, vector, top)
    : cosmos.vectorSearchDocs(coll, pkValue, vectorField, vector, top);
}

/**
 * Id generation is intentionally backend-independent: both implementations produce the identical
 * shape, so ids minted before a cutover stay valid after it and vice versa. Re-exported through the
 * dispatcher purely so no consumer needs a direct backend import to get one.
 */
export function newId(prefix: string): string {
  return cosmos.newId(prefix);
}
