import { test } from 'node:test';
import assert from 'node:assert/strict';
import { awsAdminTesting } from './tools.js';
import { AWS_ADMIN_ACCOUNT_ID, AWS_ADMIN_PUBLIC_DATA_SOURCE_ID, AWS_ADMIN_PUBLIC_KB_ID, AWS_ADMIN_PUBLIC_PREFIX, AWS_ADMIN_TASK_ROLE_NAME } from './policy.js';

const credentials = { accessKeyId: 'TESTACCESSKEY', secretAccessKey: 'test-secret-not-a-credential', sessionToken: 'test-session-token' };
const publicEnv = {
  AWS_ADMIN_PUBLIC_KB_ID,
  AWS_ADMIN_PUBLIC_DATA_SOURCE_ID,
};
const stubDependencies = (fetcher: typeof fetch, env: Record<string, string | undefined> = publicEnv) => ({
  credentials: async () => credentials,
  fetch: fetcher,
  env,
});

const trustPolicy = encodeURIComponent(JSON.stringify({
  Version: '2012-10-17',
  Statement: [{
    Effect: 'Allow', Principal: { Service: 'bedrock.amazonaws.com' }, Action: 'sts:AssumeRole',
    Condition: {
      StringEquals: { 'aws:SourceAccount': AWS_ADMIN_ACCOUNT_ID },
      ArnLike: { 'aws:SourceArn': `arn:aws:bedrock:us-east-1:${AWS_ADMIN_ACCOUNT_ID}:knowledge-base/${AWS_ADMIN_PUBLIC_KB_ID}` },
    },
  }],
}));

test('STS identity is verified before any configured AWS operation', async () => {
  const validFetch: typeof fetch = async (input) => {
    assert.match(String(input), /^https:\/\/sts\.us-east-1\.amazonaws\.com\//);
    return new Response(`<GetCallerIdentityResponse><GetCallerIdentityResult><Account>${AWS_ADMIN_ACCOUNT_ID}</Account><Arn>arn:aws:sts::${AWS_ADMIN_ACCOUNT_ID}:assumed-role/${AWS_ADMIN_TASK_ROLE_NAME}/gateway-task</Arn></GetCallerIdentityResult></GetCallerIdentityResponse>`, { status: 200 });
  };
  await assert.doesNotReject(() => awsAdminTesting.authenticatedCredentials(stubDependencies(validFetch)));

  const wrongFetch: typeof fetch = async () => new Response('<GetCallerIdentityResponse><GetCallerIdentityResult><Account>111122223333</Account><Arn>arn:aws:sts::111122223333:assumed-role/Admin/other</Arn></GetCallerIdentityResult></GetCallerIdentityResponse>', { status: 200 });
  await assert.rejects(() => awsAdminTesting.authenticatedCredentials(stubDependencies(wrongFetch)), /aws_runtime_identity_not_otchealth_task_role/);
});

test('missing server-side credentials fails before any AWS HTTP request', async () => {
  let requests = 0;
  const deps = { ...stubDependencies(async () => { requests++; return new Response('{}'); }), credentials: async () => null };
  await assert.rejects(() => awsAdminTesting.authenticatedCredentials(deps), /aws_runtime_credentials_unavailable/);
  assert.equal(requests, 0);
});

test('AWS target IDs are exact constants and cannot be redirected by environment configuration', () => {
  assert.throws(() => awsAdminTesting.targetPublicResources(stubDependencies(async () => new Response('{}'), {
    AWS_ADMIN_PUBLIC_KB_ID: 'ABCDEFGHIJ', AWS_ADMIN_PUBLIC_DATA_SOURCE_ID,
  })), /public_kb_target_does_not_match_fixed_allowlist/);
});

test('pinned S3 version listing accepts opaque IDs containing dots', async () => {
  const sourceId = '1ab094b6006bcc487b3e2e78f655ebc0c6628e20ce331a21372cc3c9486b9064';
  const fetcher: typeof fetch = async (input) => {
    assert.match(String(input), /versions/);
    return new Response(`<ListVersionsResult><Version><Key>${AWS_ADMIN_PUBLIC_PREFIX}${sourceId}.txt</Key><VersionId>HD7rhFzxAa_c5X_dZ7.uZOZKrfsZqR9p</VersionId><IsLatest>true</IsLatest><LastModified>2026-09-28T00:00:00Z</LastModified></Version></ListVersionsResult>`, { status: 200 });
  };
  const result = await awsAdminTesting.runRead({ operation: 's3_list_public_versions', source_id: sourceId }, stubDependencies(fetcher), credentials) as any;
  assert.equal(result.count, 1);
  assert.equal(result.versions[0].version_id, 'HD7rhFzxAa_c5X_dZ7.uZOZKrfsZqR9p');
});

test('truncated S3 public-prefix inventory fails closed before document reads or ingestion', async () => {
  let requests = 0;
  const managedSource = {
    dataSourceConfiguration: { type: 'MANAGED_KNOWLEDGE_BASE_CONNECTOR' },
    managedKnowledgeBaseConnectorConfiguration: { connectorParameters: JSON.stringify({
      type: 'S3', version: 1,
      connectionConfiguration: { bucketName: 'otchealth-finance-legal-dr-55c84f6b', bucketOwnerAccountId: AWS_ADMIN_ACCOUNT_ID },
      filterConfiguration: { inclusionPrefixes: [AWS_ADMIN_PUBLIC_PREFIX] },
      metadataFilesPrefix: AWS_ADMIN_PUBLIC_PREFIX, aclEnabled: false,
    }) },
  };
  const deps = stubDependencies(async (input) => {
    requests++;
    if (String(input).startsWith('https://bedrock.')) return new Response(JSON.stringify({ dataSource: managedSource }), { status: 200 });
    return new Response('<ListBucketResult><IsTruncated>true</IsTruncated></ListBucketResult>', { status: 200 });
  });
  await assert.rejects(() => awsAdminTesting.runWrite({ operation: 'bedrock_start_public_ingestion' }, deps, credentials), /public_prefix_inventory_truncated/);
  assert.equal(requests, 2);
});

test('ingestion status exposes AWS document and metadata counters without inventing missing values', () => {
  const result = awsAdminTesting.summarizeIngestionJob({
    ingestionJobId: 'XXZHGQLEE1', knowledgeBaseId: AWS_ADMIN_PUBLIC_KB_ID,
    dataSourceId: AWS_ADMIN_PUBLIC_DATA_SOURCE_ID, status: 'COMPLETE',
    statistics: {
      numberOfDocumentsScanned: 2, numberOfNewDocumentsIndexed: 2,
      numberOfModifiedDocumentsIndexed: 0, numberOfDocumentsFailed: 0,
      numberOfMetadataDocumentsScanned: 0, numberOfMetadataDocumentsModified: 0,
    },
  });
  assert.deepEqual(result.statistics, {
    documents_scanned: 2, new_documents_indexed: 2, modified_documents_indexed: 0,
    documents_indexed: 2, documents_failed: 0, metadata_documents_scanned: 0,
    metadata_documents_modified: 0, documents_deleted: null, documents_skipped: null,
  });
  const sparse = awsAdminTesting.summarizeIngestionJob({ status: 'IN_PROGRESS', statistics: {} });
  assert.equal((sparse.statistics as Record<string, unknown>).documents_failed, null);
  assert.equal((sparse.statistics as Record<string, unknown>).metadata_documents_scanned, null);
});

test('public S3 Put rejects any content other than the fixed approved hash before the request', async () => {
  let requests = 0;
  const deps = stubDependencies(async () => { requests++; return new Response(''); });
  await assert.rejects(() => awsAdminTesting.runWrite({ operation: 's3_put_public_document', source_id: '1ab094b6006bcc487b3e2e78f655ebc0c6628e20ce331a21372cc3c9486b9064', content: 'not the approved public source' }, deps, credentials), /public_source_hash_or_size_mismatch/);
  assert.equal(requests, 0);
});

test('Bedrock ingestion refuses a mixed source prefix before listing or mutating', async () => {
  let requests = 0;
  const deps = stubDependencies(async (_input, init) => {
    requests++;
    assert.equal(init?.method, 'GET');
    return new Response(JSON.stringify({ dataSource: {
      dataSourceConfiguration: { type: 'S3', s3Configuration: { bucketArn: 'arn:aws:s3:::otchealth-finance-legal-dr-55c84f6b', inclusionPrefixes: ['graph-trial/20260913/managed-graphrag/company/'] } },
    } }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  await assert.rejects(() => awsAdminTesting.runWrite({ operation: 'bedrock_start_public_ingestion' }, deps, credentials), /mixed_or_non_public_data_source_ingestion_refused/);
  assert.equal(requests, 1);
});

test('ECS restart requires an explicit confirmation and can only force-redeploy the fixed service', async () => {
  let requests = 0;
  const deps = stubDependencies(async (_input, init) => {
    requests++;
    assert.equal(init?.method, 'POST');
    assert.equal(new Headers(init?.headers).get('x-amz-target'), 'AmazonEC2ContainerServiceV20141113.UpdateService');
    const body = JSON.parse(String(init?.body));
    assert.deepEqual(body, { cluster: 'otchealth', service: 'otchealth-gateway', forceNewDeployment: true });
    return new Response(JSON.stringify({ service: { serviceName: 'otchealth-gateway', status: 'ACTIVE', deployments: [] } }), { status: 200 });
  });
  await assert.rejects(() => awsAdminTesting.runWrite({ operation: 'ecs_force_new_gateway_deployment' }, deps, credentials), /explicit_force_redeploy_confirmation_required/);
  assert.equal(requests, 0);
  const result = await awsAdminTesting.runWrite({ operation: 'ecs_force_new_gateway_deployment', confirm_live: true }, deps, credentials) as any;
  assert.equal(result.force_new_deployment, true);
  assert.equal(requests, 1);
});

test('IAM policy put is restricted to the public-only managed KB role and Bedrock trust context', async () => {
  const calls: Array<{ action: string; parameters: URLSearchParams }> = [];
  const fetcher: typeof fetch = async (_input, init) => {
    const parameters = new URLSearchParams(String(init?.body ?? ''));
    const action = parameters.get('Action') ?? '';
    calls.push({ action, parameters });
    if (action === 'GetRole') {
      return new Response(`<GetRoleResponse><GetRoleResult><Role><Arn>arn:aws:iam::${AWS_ADMIN_ACCOUNT_ID}:role/otchealth-company-shared-managed-kb-20260928</Arn><AssumeRolePolicyDocument>${trustPolicy}</AssumeRolePolicyDocument></Role></GetRoleResult></GetRoleResponse>`, { status: 200 });
    }
    if (action === 'GetRolePolicy') {
      return new Response('<Error><Code>NoSuchEntity</Code></Error>', { status: 404 });
    }
    if (action === 'PutRolePolicy') return new Response('<PutRolePolicyResponse/>', { status: 200 });
    throw new Error(`unexpected_action_${action}`);
  };
  const result = await awsAdminTesting.runWrite({ operation: 'iam_ensure_kb_public_read_policy' }, stubDependencies(fetcher), credentials) as any;
  assert.equal(result.updated, true);
  const put = calls.find((call) => call.action === 'PutRolePolicy');
  assert.ok(put);
  assert.equal(put!.parameters.get('RoleName'), 'otchealth-company-shared-managed-kb-20260928');
  assert.equal(put!.parameters.get('PolicyName'), 'PublicOnlyManagedKB');
  const policy = JSON.parse(put!.parameters.get('PolicyDocument')!);
  assert.deepEqual(policy.Statement, [{
    Sid: 'CompanySharedPublicRead', Effect: 'Allow', Action: ['s3:GetObject'],
    Resource: 'arn:aws:s3:::otchealth-finance-legal-dr-55c84f6b/graph-trial/20260913/managed-graphrag/company_shared/*',
  }]);
});

test('IAM policy mutation stops when the KB trust does not bind the exact public knowledge base', async () => {
  let writes = 0;
  const broadTrust = encodeURIComponent(JSON.stringify({ Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: { Service: 'bedrock.amazonaws.com' }, Action: 'sts:AssumeRole' }] }));
  const fetcher: typeof fetch = async (_input, init) => {
    const action = new URLSearchParams(String(init?.body ?? '')).get('Action');
    if (action === 'GetRole') return new Response(`<GetRoleResponse><Arn>arn:aws:iam::${AWS_ADMIN_ACCOUNT_ID}:role/otchealth-company-shared-managed-kb-20260928</Arn><AssumeRolePolicyDocument>${broadTrust}</AssumeRolePolicyDocument></GetRoleResponse>`, { status: 200 });
    if (action === 'PutRolePolicy') writes++;
    return new Response('<GetRolePolicyResponse/>', { status: 200 });
  };
  await assert.rejects(() => awsAdminTesting.runWrite({ operation: 'iam_ensure_kb_public_read_policy' }, stubDependencies(fetcher), credentials), /kb_role_trust_missing_exact_source_conditions/);
  assert.equal(writes, 0);
});

test('IAM policy mutation rejects a matching SourceArn under a negated trust operator', async () => {
  let writes = 0;
  const deceptiveTrust = encodeURIComponent(JSON.stringify({ Version: '2012-10-17', Statement: [{
    Effect: 'Allow', Principal: { Service: 'bedrock.amazonaws.com' }, Action: 'sts:AssumeRole',
    Condition: {
      StringEquals: { 'aws:SourceAccount': AWS_ADMIN_ACCOUNT_ID },
      StringNotEquals: { 'aws:SourceArn': `arn:aws:bedrock:us-east-1:${AWS_ADMIN_ACCOUNT_ID}:knowledge-base/${AWS_ADMIN_PUBLIC_KB_ID}` },
    },
  }] }));
  const fetcher: typeof fetch = async (_input, init) => {
    const action = new URLSearchParams(String(init?.body ?? '')).get('Action');
    if (action === 'GetRole') return new Response(`<GetRoleResponse><Arn>arn:aws:iam::${AWS_ADMIN_ACCOUNT_ID}:role/otchealth-company-shared-managed-kb-20260928</Arn><AssumeRolePolicyDocument>${deceptiveTrust}</AssumeRolePolicyDocument></GetRoleResponse>`, { status: 200 });
    if (action === 'PutRolePolicy') writes++;
    return new Response('<GetRolePolicyResponse/>', { status: 200 });
  };
  await assert.rejects(() => awsAdminTesting.runWrite({ operation: 'iam_ensure_kb_public_read_policy' }, stubDependencies(fetcher), credentials), /kb_role_trust_missing_exact_source_conditions/);
  assert.equal(writes, 0);
});
