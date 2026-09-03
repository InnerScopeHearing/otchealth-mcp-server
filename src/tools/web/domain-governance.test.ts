import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  loadDomainGovernance,
  domainAllowed,
  hostOf,
  tavilyDomainRequestParams,
  filterCitationsByDomain,
  filterUrlsByDomain,
  NO_DOMAIN_GOVERNANCE,
} from './domain-governance.js';

test('loadDomainGovernance: empty env fields parse to empty lists (the "not configured" no-op state)', () => {
  const gov = loadDomainGovernance({ WEB_SEARCH_DOMAIN_ALLOW: '', WEB_SEARCH_DOMAIN_DENY: '' });
  assert.deepEqual(gov, { allow: [], deny: [] });
});

test('loadDomainGovernance: CSV is trimmed, lowercased, and blank entries are dropped', () => {
  const gov = loadDomainGovernance({
    WEB_SEARCH_DOMAIN_ALLOW: ' Example.com , docs.tavily.com ,,',
    WEB_SEARCH_DOMAIN_DENY: 'Evil.example, ,Malware.test',
  });
  assert.deepEqual(gov.allow, ['example.com', 'docs.tavily.com']);
  assert.deepEqual(gov.deny, ['evil.example', 'malware.test']);
});

test('hostOf: parses a real URL, returns null for anything unparseable', () => {
  assert.equal(hostOf('https://Example.com/a/b?q=1'), 'example.com');
  assert.equal(hostOf('not a url'), null);
  assert.equal(hostOf(''), null);
});

test('domainAllowed: no lists configured -> everything allowed', () => {
  assert.equal(domainAllowed('https://anything.example/page', NO_DOMAIN_GOVERNANCE), true);
});

test('domainAllowed: deny list blocks an exact-match domain and any subdomain of it', () => {
  const gov = { allow: [], deny: ['evil.example'] };
  assert.equal(domainAllowed('https://evil.example/page', gov), false);
  assert.equal(domainAllowed('https://sub.evil.example/page', gov), false, 'a subdomain of a denied domain is also denied');
  assert.equal(domainAllowed('https://not-evil.example/page', gov), true, 'a different domain is unaffected');
});

test('domainAllowed: allow list, when non-empty, admits ONLY matching domains (and their subdomains)', () => {
  const gov = { allow: ['docs.tavily.com'], deny: [] };
  assert.equal(domainAllowed('https://docs.tavily.com/api', gov), true);
  assert.equal(domainAllowed('https://beta.docs.tavily.com/api', gov), true, 'subdomain of an allowed domain is admitted');
  assert.equal(domainAllowed('https://example.com/page', gov), false, 'not on the allowlist -> excluded');
});

test('domainAllowed: DENY WINS -- a domain on both lists is still excluded', () => {
  const gov = { allow: ['example.com'], deny: ['example.com'] };
  assert.equal(domainAllowed('https://example.com/page', gov), false);
});

test('domainAllowed: an unparseable/missing host is fail-OPEN (nothing to govern -- citations behavior)', () => {
  const gov = { allow: ['example.com'], deny: ['evil.example'] };
  assert.equal(domainAllowed('not a url at all', gov), true);
});

test('tavilyDomainRequestParams: empty governance produces an empty object (no keys at all, not empty arrays)', () => {
  const params = tavilyDomainRequestParams(NO_DOMAIN_GOVERNANCE);
  assert.deepEqual(params, {});
  assert.equal('include_domains' in params, false);
  assert.equal('exclude_domains' in params, false);
});

test('tavilyDomainRequestParams: maps allow -> include_domains, deny -> exclude_domains, only when non-empty', () => {
  assert.deepEqual(tavilyDomainRequestParams({ allow: ['a.com'], deny: [] }), { include_domains: ['a.com'] });
  assert.deepEqual(tavilyDomainRequestParams({ allow: [], deny: ['b.com'] }), { exclude_domains: ['b.com'] });
  assert.deepEqual(tavilyDomainRequestParams({ allow: ['a.com'], deny: ['b.com'] }), {
    include_domains: ['a.com'],
    exclude_domains: ['b.com'],
  });
});

test('filterCitationsByDomain: a true no-op (same array reference) when governance is empty', () => {
  const items = [{ title: 'x', url: 'https://example.com' }];
  assert.equal(filterCitationsByDomain(items, NO_DOMAIN_GOVERNANCE), items);
});

test('filterCitationsByDomain: drops denied citations, keeps a title-only citation with no url', () => {
  const gov = { allow: [], deny: ['evil.example'] };
  const items = [
    { title: 'good', url: 'https://good.example' },
    { title: 'bad', url: 'https://evil.example/page' },
    { title: 'no url at all -- must pass through, nothing to govern' },
  ];
  const out = filterCitationsByDomain(items, gov);
  assert.deepEqual(out, [
    { title: 'good', url: 'https://good.example' },
    { title: 'no url at all -- must pass through, nothing to govern' },
  ]);
});

test('filterCitationsByDomain: an allowlist keeps only matching citations, still passing through url-less ones', () => {
  const gov = { allow: ['good.example'], deny: [] };
  const items = [
    { title: 'good', url: 'https://good.example/a' },
    { title: 'not allowed', url: 'https://other.example/a' },
    { title: 'no url' },
  ];
  assert.deepEqual(filterCitationsByDomain(items, gov), [
    { title: 'good', url: 'https://good.example/a' },
    { title: 'no url' },
  ]);
});

test('filterUrlsByDomain: a true no-op (same array reference, empty dropped) when governance is empty', () => {
  const items = [{ url: 'https://example.com' }];
  const { kept, dropped } = filterUrlsByDomain(items, NO_DOMAIN_GOVERNANCE);
  assert.equal(kept, items);
  assert.deepEqual(dropped, []);
});

test('filterUrlsByDomain: splits kept/dropped by deny, and DROPS (not keeps) an unparseable URL -- opposite default from citations', () => {
  const gov = { allow: [], deny: ['evil.example'] };
  const items = [
    { url: 'https://good.example/a' },
    { url: 'https://evil.example/b' },
    { url: 'not a url' },
  ];
  const { kept, dropped } = filterUrlsByDomain(items, gov);
  assert.deepEqual(kept, [{ url: 'https://good.example/a' }]);
  assert.deepEqual(dropped, [{ url: 'https://evil.example/b' }, { url: 'not a url' }]);
});

test('filterUrlsByDomain: DENY WINS over an overlapping allow entry', () => {
  const gov = { allow: ['example.com'], deny: ['example.com'] };
  const { kept, dropped } = filterUrlsByDomain([{ url: 'https://example.com/x' }], gov);
  assert.deepEqual(kept, []);
  assert.deepEqual(dropped, [{ url: 'https://example.com/x' }]);
});
