import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectSupersession,
  agentFromDocId,
  odataEscape,
  type SupersedeRuntimeDeps,
} from './auto-supersede-runtime.js';
import type { KbHit } from '../azure/search.js';

// Orthogonal unit vectors: A·A parallel => cosine 1 (near-duplicate); A·B orthogonal => cosine 0.
const A = [1, 0, 0];
const B = [0, 1, 0];

function hit(id: string, type: string, text = 'X is 42'): KbHit {
  return { id, type, text, score: 1 };
}

interface Spies {
  searchCalls: number;
  chatCalls: number;
  emits: Array<{ event: string; props: Record<string, unknown> }>;
}

function makeDeps(over: {
  mode: string;
  hits?: KbHit[];
  searchThrows?: boolean;
  candVec?: number[] | null;
  chatText?: string;
}): { deps: Partial<SupersedeRuntimeDeps>; spies: Spies } {
  const spies: Spies = { searchCalls: 0, chatCalls: 0, emits: [] };
  const deps: Partial<SupersedeRuntimeDeps> = {
    mode: () => over.mode,
    search: async () => {
      spies.searchCalls++;
      if (over.searchThrows) throw new Error('search down');
      return { matches: over.hits ?? [], mode: 'test' };
    },
    embedText: async () => (over.candVec === undefined ? A : over.candVec),
    chatFn: async () => {
      spies.chatCalls++;
      return { text: over.chatText ?? '{"contradicts":true,"confidence":0.9,"reason":"value changed"}', model: 'fake' };
    },
    emit: (event, props) => spies.emits.push({ event, props }),
  };
  return { deps, spies };
}

// A new fact that contradicts the prior "X is 42".
const NEW = { agent: 'cto', kind: 'fact', text: 'X is now 44', vector: A };

// ── pure helpers ─────────────────────────────────────────────────────────────────────────────────
test('agentFromDocId / odataEscape are pure and correct', () => {
  assert.equal(agentFromDocId('cto__20260101-007'), 'cto');
  assert.equal(agentFromDocId('cfo__m_abc__weird'), 'cfo', 'agent is everything before the FIRST __');
  assert.equal(agentFromDocId('nodelim'), '');
  assert.equal(agentFromDocId(null), '');
  assert.equal(odataEscape("O'Brien"), "O''Brien");
});

// ── cheap short-circuits (no I/O) ────────────────────────────────────────────────────────────────
test('mode=off: detection skipped, search never called', async () => {
  const { deps, spies } = makeDeps({ mode: 'off' });
  const out = await detectSupersession(NEW, deps);
  assert.equal(out.action, 'none');
  assert.equal(spies.searchCalls, 0);
});

test('new kind not supersedable (status): skipped before any I/O', async () => {
  const { deps, spies } = makeDeps({ mode: 'auto' });
  const out = await detectSupersession({ ...NEW, kind: 'status' }, deps);
  assert.equal(out.action, 'none');
  assert.equal(spies.searchCalls, 0);
});

// ── the load-bearing behaviors ───────────────────────────────────────────────────────────────────
test('AUTO: confident same-subject contradiction -> auto-link + linked beacon', async () => {
  const { deps, spies } = makeDeps({ mode: 'auto', hits: [hit('cto__20260101-007', 'fact')], candVec: A });
  const out = await detectSupersession(NEW, deps);
  assert.equal(out.action, 'auto-link');
  assert.equal(out.supersedeId, '20260101-007');
  assert.equal(spies.chatCalls, 1);
  assert.equal(spies.emits[0]?.event, 'memory_supersede_linked');
  assert.equal(spies.emits[0]?.props.superseded_id, '20260101-007');
});

test('SUGGEST (default posture): the SAME contradiction only suggests, never links', async () => {
  const { deps, spies } = makeDeps({ mode: 'suggest', hits: [hit('cto__20260101-007', 'fact')], candVec: A });
  const out = await detectSupersession(NEW, deps);
  assert.equal(out.action, 'suggest');
  assert.equal(out.supersedeId, '20260101-007');
  assert.equal(spies.emits[0]?.event, 'memory_supersede_suggested');
});

test('COST GUARD: below the cosine threshold the LLM is NEVER called -> none', async () => {
  const { deps, spies } = makeDeps({ mode: 'auto', hits: [hit('cto__x', 'fact')], candVec: B }); // orthogonal => sim 0
  const out = await detectSupersession(NEW, deps);
  assert.equal(out.action, 'none');
  assert.equal(spies.chatCalls, 0, 'the contradiction check must not run on a non-near-duplicate');
});

test('CROSS-AGENT GUARD: a candidate in another lane is excluded (server filter fail-open safety)', async () => {
  const { deps } = makeDeps({ mode: 'auto', hits: [hit('cfo__99', 'fact')], candVec: A });
  const out = await detectSupersession(NEW, deps); // writer lane = cto, candidate lane = cfo
  assert.equal(out.action, 'none');
});

test('a status/episode candidate is not supersedable -> none', async () => {
  const { deps } = makeDeps({ mode: 'auto', hits: [hit('cto__s', 'status')], candVec: A });
  assert.equal((await detectSupersession(NEW, deps)).action, 'none');
});

test('classifier says NO contradiction -> none even at high similarity', async () => {
  const { deps } = makeDeps({
    mode: 'auto',
    hits: [hit('cto__7', 'fact')],
    candVec: A,
    chatText: '{"contradicts":false,"confidence":0.95,"reason":"added detail"}',
  });
  assert.equal((await detectSupersession(NEW, deps)).action, 'none');
});

test('FAIL-OPEN: search throws -> none, never propagates', async () => {
  const { deps } = makeDeps({ mode: 'auto', searchThrows: true });
  assert.equal((await detectSupersession(NEW, deps)).action, 'none');
});

test('no candidates -> none, no LLM', async () => {
  const { deps, spies } = makeDeps({ mode: 'auto', hits: [] });
  assert.equal((await detectSupersession(NEW, deps)).action, 'none');
  assert.equal(spies.chatCalls, 0);
});

test('null new vector -> cosine 0 -> below threshold -> none, no LLM', async () => {
  const { deps, spies } = makeDeps({ mode: 'auto', hits: [hit('cto__7', 'fact')], candVec: A });
  assert.equal((await detectSupersession({ ...NEW, vector: null }, deps)).action, 'none');
  assert.equal(spies.chatCalls, 0);
});

test('an explicit caller supersedes is respected by the handler layer, so detection is not consulted for it', async () => {
  // detectSupersession itself always runs when called; the HANDLERS skip it when input.supersedes is
  // set (see memory-write.ts / remember.ts). This asserts the runtime has no hidden dependency on
  // that: called directly it still behaves, so the handler-level guard is the single source of truth.
  const { deps } = makeDeps({ mode: 'auto', hits: [hit('cto__7', 'fact')], candVec: A });
  const out = await detectSupersession(NEW, deps);
  assert.equal(out.action, 'auto-link');
});
