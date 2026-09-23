import test from 'node:test';
import assert from 'node:assert/strict';
import { SERVICE_CATALOG, serviceCapabilities } from './catalog.js';

test('retired Azure Document Intelligence is classified as retired and exposes no credential requirement', () => {
  const info = SERVICE_CATALOG.docintel;
  assert.equal(info.status, 'retired');
  assert.equal(info.auth, 'none, retired');
  assert.match(info.description, /retired/i);
  assert.doesNotMatch(info.description, /endpoint|key|secret/i);
  assert.match(info.rule ?? '', /fail closed/i);
  assert.deepEqual(serviceCapabilities('docintel').available_not_wired, []);
});

test('Bedrock-backed safety services do not advertise Azure as a live provider', () => {
  for (const service of ['shield', 'groundedness']) {
    const info = SERVICE_CATALOG[service];
    assert.equal(info.status, 'wired');
    assert.match(info.description, /Bedrock Guardrails/);
    assert.match(info.description, /Azure .*retired/i);
    assert.doesNotMatch(info.description, /Azure .*endpoint|Azure .*key/i);
  }
});

test('supported LLM catalog path remains OpenAI-direct', () => {
  assert.equal(SERVICE_CATALOG.llm.status, 'wired');
  assert.match(SERVICE_CATALOG.llm.description, /OpenAI-direct/);
  assert.match(SERVICE_CATALOG.llm.auth, /OPENAI_API_KEY/);
});
