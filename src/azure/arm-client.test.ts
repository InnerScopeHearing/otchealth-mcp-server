import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertNonPhiTarget,
  redactContainerApp,
  azureConfig,
  assertContainerAppEnvSafe,
  mergeEnv,
  GATEWAY_APP_NAME,
} from './arm-client.js';

test('assertNonPhiTarget refuses PHI-ring targets', () => {
  assert.throws(() => assertNonPhiTarget('medreview-prod'), /PHI-ring deny-list/);
  assert.throws(() => assertNonPhiTarget('rg-patient-data'), /PHI-ring deny-list/);
  assert.throws(() => assertNonPhiTarget('audiogram-index'), /PHI-ring deny-list/);
  assert.throws(() => assertNonPhiTarget('some-hipaa-thing'), /PHI-ring deny-list/);
  assert.throws(() => assertNonPhiTarget('hearing_number_idx'), /PHI-ring deny-list/);
});

test('assertNonPhiTarget allows normal non-PHI targets', () => {
  assert.doesNotThrow(() => assertNonPhiTarget('otchealth-automation-rg'));
  assert.doesNotThrow(() => assertNonPhiTarget('daily-digest'));
  assert.doesNotThrow(() => assertNonPhiTarget('otchealth-brain', 'otchealth-brain-search'));
  assert.doesNotThrow(() => assertNonPhiTarget(undefined, null));
});

test('redactContainerApp returns env-var NAMES only, never values or secret values', () => {
  const raw = {
    name: 'otchealth-mcp-gateway',
    id: '/subscriptions/sub/resourceGroups/rg-otchealth-apps-prod/providers/Microsoft.App/containerApps/otchealth-mcp-gateway',
    location: 'East US 2',
    identity: { type: 'SystemAssigned', principalId: 'should-not-leak-as-value' },
    properties: {
      provisioningState: 'Succeeded',
      latestRevisionName: 'otchealth-mcp-gateway--gabc123',
      configuration: {
        activeRevisionsMode: 'Multiple',
        ingress: { fqdn: 'mcp.example.net' },
        secrets: [{ name: 'brain-search-key', value: 'SUPER_SECRET_VALUE' }],
      },
      template: {
        containers: [
          {
            name: 'app',
            image: 'acr.azurecr.io/otchealth-mcp-server@sha256:deadbeef',
            env: [
              { name: 'NODE_ENV', value: 'production' },
              { name: 'COSMOS_KEY', secretRef: 'cosmos-key' },
              { name: 'OAUTH_TOKEN_SIGNING_SECRET', value: 'PLAINTEXT_SIGNING_SECRET' },
            ],
          },
        ],
        scale: { minReplicas: 2, maxReplicas: 10, rules: [{ name: 'http-concurrency' }] },
      },
    },
  };

  const out = redactContainerApp(raw);
  const flat = JSON.stringify(out);

  // No env-var VALUE or secret VALUE may appear anywhere in the output.
  assert.ok(!flat.includes('production') || !flat.includes('NODE_ENV=production'));
  assert.ok(!flat.includes('SUPER_SECRET_VALUE'), 'secret value leaked');
  assert.ok(!flat.includes('PLAINTEXT_SIGNING_SECRET'), 'env-var plaintext value leaked');

  // Env-var NAMES and secretRef NAMES ARE present.
  const container = (out.containers as Array<Record<string, unknown>>)[0];
  const envNames = (container.envVarNames as Array<{ name: string; fromSecret: boolean; secretRef?: string }>);
  assert.deepEqual(envNames.map((e) => e.name).sort(), ['COSMOS_KEY', 'NODE_ENV', 'OAUTH_TOKEN_SIGNING_SECRET']);
  const cosmos = envNames.find((e) => e.name === 'COSMOS_KEY')!;
  assert.equal(cosmos.fromSecret, true);
  assert.equal(cosmos.secretRef, 'cosmos-key');
  const nodeEnv = envNames.find((e) => e.name === 'NODE_ENV')!;
  assert.equal(nodeEnv.fromSecret, false);
  assert.ok(!('value' in nodeEnv), 'value field must be stripped');

  // Secret NAMES only (no values).
  assert.deepEqual(out.secretNames, ['brain-search-key']);

  // Useful non-secret metadata is preserved.
  assert.equal(out.provisioningState, 'Succeeded');
  assert.equal(out.resourceGroup, 'rg-otchealth-apps-prod');
  assert.equal((out.scale as Record<string, unknown>).maxReplicas, 10);
  assert.equal(out.identity, 'SystemAssigned');
});

test('assertContainerAppEnvSafe hard-denies the gateway oauth-clients binding', () => {
  // by env-var name (any casing / separator)
  assert.throws(() => assertContainerAppEnvSafe(GATEWAY_APP_NAME, [{ name: 'oauth-clients', value: 'x' }]), /incident 20260713-019/);
  assert.throws(() => assertContainerAppEnvSafe(GATEWAY_APP_NAME, [{ name: 'OAUTH_CLIENTS', value: 'x' }]), /oauth-clients/);
  // by secretRef
  assert.throws(() => assertContainerAppEnvSafe(GATEWAY_APP_NAME, [{ name: 'SOMETHING', secretRef: 'oauth-clients' }]), /oauth-clients/);
});

test('assertContainerAppEnvSafe allows safe env on the gateway and anything on other apps', () => {
  assert.doesNotThrow(() => assertContainerAppEnvSafe(GATEWAY_APP_NAME, [{ name: 'LLM_CACHE_MODE', value: 'on' }]));
  // oauth-clients is only denied ON THE GATEWAY; a different app is unaffected.
  assert.doesNotThrow(() => assertContainerAppEnvSafe('some-other-app', [{ name: 'oauth-clients', value: 'x' }]));
});

test('mergeEnv is non-destructive: updates existing, adds new, drops nothing', () => {
  const existing = [
    { name: 'KEEP_ME', value: 'stays' },
    { name: 'UPDATE_ME', value: 'old' },
    { name: 'SECRET_BOUND', secretRef: 'some-secret' },
  ];
  const { merged, changed } = mergeEnv(existing, [
    { name: 'UPDATE_ME', value: 'new' },
    { name: 'BRAND_NEW', value: 'added' },
    { name: 'NOW_SECRET', secretRef: 'kv-thing' },
  ]);
  const byName = Object.fromEntries(merged.map((e) => [e.name, e]));
  assert.equal(byName['KEEP_ME'].value, 'stays', 'existing untouched var must survive');
  assert.equal(byName['SECRET_BOUND'].secretRef, 'some-secret', 'existing secretRef must survive');
  assert.equal(byName['UPDATE_ME'].value, 'new', 'existing var value updated');
  assert.equal(byName['BRAND_NEW'].value, 'added', 'new var added');
  assert.equal(byName['NOW_SECRET'].secretRef, 'kv-thing', 'new secretRef added');
  assert.equal(merged.length, 5, 'nothing dropped (3 existing + 2 new)');
  assert.deepEqual(changed.sort(), ['BRAND_NEW', 'NOW_SECRET', 'UPDATE_ME']);
});

test('azureConfig defaults are the known non-secret identifiers', () => {
  const c = azureConfig();
  assert.equal(c.subscriptionId, '55c84f6b-ef90-4259-a58b-50835cc4cab4');
  assert.ok(c.readerResourceGroups.includes('otchealth-automation-rg'));
  assert.ok(c.searchServices.includes('otchealth-brain-search'));
});
