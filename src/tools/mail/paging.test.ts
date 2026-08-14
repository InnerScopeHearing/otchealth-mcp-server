import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSearchPaging } from './client.js';

// The XML fragments below are the real RootFolder shapes EWS FindItem returns, not invented ones.

test('THE DEFECT: a page that is 25 of 1,400 is reported as truncated, not as a settled result', () => {
  const xml = '<m:RootFolder IndexedPagingOffset="25" TotalItemsInView="1400" IncludesLastItemInRange="false">';
  const p = parseSearchPaging(xml, 0, 25);
  assert.equal(p.totalInView, 1400);
  assert.equal(p.includesLastItem, false);
  assert.equal(p.truncated, true, 'this is the false-negative that read as a finished search');
});

test('a complete match set is NOT flagged truncated', () => {
  const xml = '<m:RootFolder TotalItemsInView="7" IncludesLastItemInRange="true">';
  const p = parseSearchPaging(xml, 0, 7);
  assert.equal(p.truncated, false);
  assert.equal(p.totalInView, 7);
});

test('the LAST page of a paged walk is complete even though earlier pages were not', () => {
  const xml = '<m:RootFolder IndexedPagingOffset="1400" TotalItemsInView="1400" IncludesLastItemInRange="true">';
  assert.equal(parseSearchPaging(xml, 1375, 25).truncated, false);
});

test('attribute ORDER is not assumed', () => {
  const xml = '<m:RootFolder IncludesLastItemInRange="false" TotalItemsInView="93" IndexedPagingOffset="0">';
  const p = parseSearchPaging(xml, 0, 25);
  assert.equal(p.totalInView, 93);
  assert.equal(p.truncated, true);
});

test('a genuinely empty search is complete, not truncated', () => {
  const xml = '<m:RootFolder TotalItemsInView="0" IncludesLastItemInRange="true">';
  const p = parseSearchPaging(xml, 0, 0);
  assert.equal(p.totalInView, 0);
  assert.equal(p.truncated, false, 'zero matches is a real answer; do not label it partial');
});

test('FALLBACK: with IncludesLastItemInRange absent, arithmetic still catches truncation', () => {
  const xml = '<m:RootFolder TotalItemsInView="500">';
  assert.equal(parseSearchPaging(xml, 0, 25).truncated, true, '25 of 500 is partial');
  assert.equal(parseSearchPaging(xml, 475, 25).truncated, false, 'offset+returned reaches the total');
});

test('UNKNOWN stays unknown: missing attributes never become a confident answer', () => {
  // Reporting truncated=true here would cry wolf on every search; reporting totalInView=0 would be
  // a fabricated fact. Both must degrade to null/false-without-claim.
  const p = parseSearchPaging('<m:RootFolder>', 0, 25);
  assert.equal(p.totalInView, null);
  assert.equal(p.includesLastItem, null);
  assert.equal(p.truncated, false);

  const none = parseSearchPaging('<soap:Envelope><m:FindItemResponse /></soap:Envelope>', 0, 0);
  assert.equal(none.totalInView, null);
  assert.equal(none.includesLastItem, null);
  assert.equal(none.truncated, false);
});

test('the server statement WINS over the arithmetic when they disagree', () => {
  // Counting alone would call this complete (0+25 >= 25). EWS says otherwise, and EWS is the
  // authority on its own paging, so a caller is still told to keep walking.
  const xml = '<m:RootFolder TotalItemsInView="25" IncludesLastItemInRange="false">';
  assert.equal(parseSearchPaging(xml, 0, 25).truncated, true);
});

test('namespace prefix is not hard-coded', () => {
  assert.equal(parseSearchPaging('<t:RootFolder TotalItemsInView="42" IncludesLastItemInRange="false">', 0, 10).truncated, true);
  assert.equal(parseSearchPaging('<RootFolder TotalItemsInView="42" IncludesLastItemInRange="false">', 0, 10).totalInView, 42);
});
