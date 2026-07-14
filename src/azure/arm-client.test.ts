import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertNonPhiTarget,
  redactContainerApp,
  azureConfig,
  assertContainerAppEnvSafe,
  mergeEnv,
  GATEWAY_APP_NAME,
  redactJob,
  applyJobPatch,
  computeJobUpsertDrops,
} from './arm-client.js';

// A representative live daily-digest job (the 07-05 shape): a UAMI identity, 3 env vars, a scheduled
// cron trigger, and a registry with UAMI pull. This is the fixture the job-tool tests diff against.
const LIVE_JOB = {
  name: 'daily-digest',
  id: '/subscriptions/sub/resourceGroups/otchealth-automation-rg/providers/Microsoft.App/jobs/daily-digest',
  location: 'East US 2',
  identity: {
    type: 'UserAssigned',
    userAssignedIdentities: {
      '/subscriptions/sub/resourcegroups/otchealth-automation-rg/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-otc-jobs-kv': {},
    },
  },
  properties: {
    provisioningState: 'Succeeded',
    environmentId: '/subscriptions/sub/.../managedEnvironments/otchealth-jobs-env',
    configuration: {
      triggerType: 'Schedule',
      scheduleTriggerConfig: { cronExpression: '59 23 * * *', parallelism: 1, replicaCompletionCount: 1 },
      replicaTimeout: 7200,
      replicaRetryLimit: 1,
      secrets: [{ name: 'sab64', value: 'SUPER_SECRET_SA' }],
      registries: [{ server: 'otchealthacr.azurecr.io', identity: 'id-otc-jobs-kv' }],
    },
    template: {
      containers: [
        {
          name: 'doc-indexer',
          image: 'otchealthacr.azurecr.io/doc-indexer@sha256:OLD',
          env: [
            { name: 'AZURE_KEYVAULT_NAME', value: 'kv-otc-55c84f6bef' },
            { name: 'AZURE_UAMI_CLIENT_ID', value: 'PLAINTEXT_CLIENT_ID' },
            { name: 'CU_MAX_MINUTES', value: '110' },
          ],
          resources: { cpu: 2, memory: '4Gi' },
        },
      ],
    },
  },
};

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

// ===== azure_job_get / azure_job_update / azure_job_upsert hardening (07-05 guardrails) =====

test('redactJob surfaces the identity + cron but NEVER an env-var or secret value', () => {
  const out = redactJob(LIVE_JOB);
  const flat = JSON.stringify(out);
  assert.ok(!flat.includes('SUPER_SECRET_SA'), 'secret value leaked');
  assert.ok(!flat.includes('PLAINTEXT_CLIENT_ID'), 'env-var value leaked');
  // identity is surfaced (type + UAMI resource ids) -- the field the 07-05 failure lost.
  const ident = out.identity as { type: string; userAssignedIdentities: string[] };
  assert.equal(ident.type, 'UserAssigned');
  assert.equal(ident.userAssignedIdentities.length, 1);
  assert.ok(ident.userAssignedIdentities[0].endsWith('id-otc-jobs-kv'));
  // env-var NAMES only; the `value` field is stripped.
  const env = (out.containers as Array<{ envVarNames: Array<{ name: string; value?: string }> }>)[0].envVarNames;
  assert.deepEqual(env.map((e) => e.name).sort(), ['AZURE_KEYVAULT_NAME', 'AZURE_UAMI_CLIENT_ID', 'CU_MAX_MINUTES']);
  assert.ok(!('value' in env[0]));
  assert.equal(out.cron, '59 23 * * *');
  assert.equal(out.triggerType, 'Schedule');
  assert.deepEqual(out.secretNames, ['sab64']);
  assert.equal((out.registries as Array<{ server: string }>)[0].server, 'otchealthacr.azurecr.io');
});

test('applyJobPatch (image) sends the FULL container array with only the image swapped (preserves env)', () => {
  const { patchBody, diff, touched } = applyJobPatch(LIVE_JOB, { image: 'otchealthacr.azurecr.io/doc-indexer@sha256:NEW' });
  assert.deepEqual(touched, ['image']);
  assert.equal(diff[0].field, 'image');
  const c0 = ((patchBody.properties as Record<string, unknown>).template as { containers: Array<Record<string, unknown>> }).containers[0];
  assert.equal(c0.image, 'otchealthacr.azurecr.io/doc-indexer@sha256:NEW');
  // env survives (the whole point: an array replace with a partial container would drop it).
  assert.equal((c0.env as unknown[]).length, 3, 'env must ride along in the full-array PATCH');
  // no configuration key touched when only image changes.
  assert.ok(!('configuration' in (patchBody.properties as Record<string, unknown>)));
});

test('applyJobPatch (cron) preserves the other schedule fields; multiple fields compose', () => {
  const { patchBody, touched } = applyJobPatch(LIVE_JOB, { cron: '0 6 * * *', replicaTimeout: 3600 });
  assert.deepEqual(touched.sort(), ['cron', 'replicaTimeout']);
  const cfg = (patchBody.properties as Record<string, unknown>).configuration as Record<string, unknown>;
  const sched = cfg.scheduleTriggerConfig as Record<string, unknown>;
  assert.equal(sched.cronExpression, '0 6 * * *');
  assert.equal(sched.parallelism, 1, 'existing schedule fields preserved in the PATCH');
  assert.equal(cfg.replicaTimeout, 3600);
});

test('applyJobPatch throws when no change is requested', () => {
  assert.throws(() => applyJobPatch(LIVE_JOB, {}), /no change requested/);
});

test('computeJobUpsertDrops FLAGS a dropped identity (the exact 07-05 failure)', () => {
  // a properties-only PUT (the classic azure_job_upsert body that dropped the UAMI)
  const drops = computeJobUpsertDrops(LIVE_JOB, { properties: { configuration: {}, template: {} } });
  assert.equal(drops.droppedIdentity, true);
  assert.ok(drops.warnings.some((w) => /07-05/.test(w) && /identity/i.test(w)), 'must name the identity drop + the incident');
  assert.deepEqual(drops.droppedSecrets, ['sab64']);
  assert.ok(drops.droppedEnv.includes('AZURE_KEYVAULT_NAME'));
  // Exact-array match (not .includes with a host literal, which CodeQL reads as incomplete URL
  // substring sanitization even in a test assertion). It is also a stronger assertion: the live job
  // has exactly one registry, so the full replace drops exactly it.
  assert.deepEqual(drops.droppedRegistries, ['otchealthacr.azurecr.io']);
});

test('computeJobUpsertDrops: passing the identity through preserves it (no drop)', () => {
  const drops = computeJobUpsertDrops(LIVE_JOB, {
    identity: LIVE_JOB.identity,
    properties: LIVE_JOB.properties,
  });
  assert.equal(drops.droppedIdentity, false);
  assert.deepEqual(drops.droppedSecrets, []);
  assert.deepEqual(drops.droppedEnv, []);
  assert.deepEqual(drops.warnings, []);
});

test('computeJobUpsertDrops: a first-ever create (no existing job) reports no drops', () => {
  const drops = computeJobUpsertDrops(null, { properties: {} });
  assert.equal(drops.droppedIdentity, false);
  assert.deepEqual(drops.warnings, []);
});
