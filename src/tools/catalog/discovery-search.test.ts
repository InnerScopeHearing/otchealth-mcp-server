import { test } from 'node:test';
import assert from 'node:assert/strict';
import { searchDiscoveryTools, type DiscoveryTool } from './discovery-search.js';

const tool = (name: string, description?: string): DiscoveryTool => ({
  name,
  ...(description === undefined ? {} : { description }),
  inputSchema: { type: 'object', properties: { secret: { type: 'string' } } },
});

test('discovery searches only supplied contracts and returns bounded summaries by default', () => {
  const supplied = [tool('crm_contact_search', 'Search customer contacts. '.repeat(30))];
  const before = structuredClone(supplied);
  const result = searchDiscoveryTools(supplied, { query: 'contact search' });

  assert.equal(result.totalMatches, 1);
  assert.equal(result.truncated, false);
  assert.equal(result.matches[0].name, 'crm_contact_search');
  assert.ok((result.matches[0].description?.length ?? 0) <= 160);
  assert.equal('inputSchema' in result.matches[0], false);
  assert.deepEqual(supplied, before);
  assert.deepEqual(searchDiscoveryTools([tool('admin_delete_everything')], { query: 'contact search' }).matches, []);
});

test('name matches rank ahead of description matches with stable name tie breaks', () => {
  const supplied = [
    tool('z_search', 'No relevant description'),
    tool('a_search', 'No relevant description'),
    tool('unrelated', 'Search records here'),
    tool('search', 'Exact name'),
  ];
  const result = searchDiscoveryTools(supplied, { query: 'search', limit: 10 });

  assert.deepEqual(result.matches.map(({ name }) => name), ['search', 'a_search', 'z_search', 'unrelated']);
  assert.equal(result.totalMatches, 4);
  assert.equal(result.truncated, false);
});

test('limits are bounded and schema is included only when explicitly requested', () => {
  const supplied = Array.from({ length: 12 }, (_, index) => tool(`lookup_${index}`));
  const defaultResult = searchDiscoveryTools(supplied, { query: 'lookup' });
  assert.equal(defaultResult.matches.length, 5);
  assert.equal(defaultResult.totalMatches, 12);
  assert.equal(defaultResult.truncated, true);

  const capped = searchDiscoveryTools(supplied, { query: 'lookup', limit: 100, includeSchema: true });
  assert.equal(capped.matches.length, 10);
  assert.equal('inputSchema' in capped.matches[0], true);
  assert.equal(capped.truncated, true);
});

test('malformed or oversized search options fail without echoing caller input', () => {
  const oversizedQuery = 'x'.repeat(121);
  assert.throws(() => searchDiscoveryTools([], { query: oversizedQuery }), (error: unknown) => {
    assert.ok(error instanceof TypeError);
    assert.equal(error.message.includes(oversizedQuery), false);
    return true;
  });
  assert.throws(() => searchDiscoveryTools([], { query: 'lookup', limit: 0 }), TypeError);
  assert.throws(() => searchDiscoveryTools([], { query: 'lookup', includeSchema: 'yes' as unknown as boolean }), TypeError);
});
