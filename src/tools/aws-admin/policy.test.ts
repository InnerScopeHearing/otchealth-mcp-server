import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AWS_ADMIN_ACCOUNT_ID, AWS_ADMIN_BUCKET, AWS_ADMIN_MIXED_DATA_SOURCE_ID, AWS_ADMIN_MIXED_KB_ID,
  AWS_ADMIN_PUBLIC_DATA_SOURCE_ID, AWS_ADMIN_PUBLIC_KB_ID, AWS_ADMIN_PUBLIC_PREFIX,
  AWS_ADMIN_PUBLIC_SOURCES, AWS_ADMIN_PUBLIC_SOURCE_VERSIONS, AWS_ADMIN_TASK_ROLE_NAME,
  canUpdatePublicDataSource, expectedPublicReadStatement, expectedPublicSourceHash,
  isDedicatedPublicKb, isPublicSourceId, isSafePublicSourceSet, mergePublicReadStatement,
  parsePublicDataSourceScope, policyHasExpectedPublicRead, publicMetadataKey, publicSourceKey,
  runtimeTaskRoleArnMatches,
} from './policy.js';

const ids = Object.keys(AWS_ADMIN_PUBLIC_SOURCES);
const allowedKeys = ids.flatMap((id) => [publicSourceKey(id)!, publicMetadataKey(id)!]);

test('public source registry accepts only the two PR 737 IDs and fixed content hashes', () => {
  assert.equal(ids.length, 2);
  for (const id of ids) assert.match(expectedPublicSourceHash(id)!, /^[a-f0-9]{64}$/);
  assert.equal(isPublicSourceId('0'.repeat(64)), false);
  assert.equal(isPublicSourceId(ids[0]!), true);
  assert.deepEqual(Object.keys(AWS_ADMIN_PUBLIC_SOURCE_VERSIONS).sort(), ids.sort());
});

test('managed KB S3 connector is accepted only for the exact public bucket, owner, prefix, metadata path and ACL-off config', () => {
  const managed = {
    type: 'MANAGED_KNOWLEDGE_BASE_CONNECTOR',
    dataSourceConfiguration: { type: 'MANAGED_KNOWLEDGE_BASE_CONNECTOR' },
    managedKnowledgeBaseConnectorConfiguration: {
      connectorParameters: JSON.stringify({
        type: 'S3', version: 1,
        connectionConfiguration: { bucketName: AWS_ADMIN_BUCKET, bucketOwnerAccountId: AWS_ADMIN_ACCOUNT_ID },
        filterConfiguration: { inclusionPrefixes: [AWS_ADMIN_PUBLIC_PREFIX] },
        metadataFilesPrefix: AWS_ADMIN_PUBLIC_PREFIX,
        aclEnabled: false,
      }),
    },
  };
  assert.equal(parsePublicDataSourceScope(managed), 'company_shared');
  assert.equal(canUpdatePublicDataSource(managed), true);

  const wider = structuredClone(managed);
  const parameters = JSON.parse(wider.managedKnowledgeBaseConnectorConfiguration.connectorParameters);
  parameters.filterConfiguration.inclusionPrefixes = ['graph-trial/20260913/managed-graphrag/'];
  wider.managedKnowledgeBaseConnectorConfiguration.connectorParameters = JSON.stringify(parameters);
  assert.equal(parsePublicDataSourceScope(wider), 'unsafe');
  assert.equal(canUpdatePublicDataSource(wider), false);
});

test('classic mixed company/ source cannot be updated or ingested through the public operation', () => {
  const mixed = {
    dataSourceConfiguration: {
      type: 'S3',
      s3Configuration: {
        bucketArn: `arn:aws:s3:::${AWS_ADMIN_BUCKET}`,
        inclusionPrefixes: ['graph-trial/20260913/managed-graphrag/company/'],
      },
    },
  };
  assert.equal(parsePublicDataSourceScope(mixed), 'unsafe');
  assert.equal(canUpdatePublicDataSource(mixed), false);
});

test('managed-KB preflight requires the exact two documents but does not require custom-metadata sidecars', () => {
  const documentKeys = ids.map((id) => publicSourceKey(id)!);
  assert.equal(isSafePublicSourceSet(documentKeys), true);
  assert.equal(isSafePublicSourceSet(allowedKeys), true);
  assert.equal(isSafePublicSourceSet([...documentKeys, `${AWS_ADMIN_PUBLIC_PREFIX}manifest.json`]), false);
  assert.equal(isSafePublicSourceSet([...documentKeys, documentKeys[0]!]), false);
  assert.deepEqual(Object.values(AWS_ADMIN_PUBLIC_SOURCE_VERSIONS).map((version) => Object.keys(version)), [['document'], ['document']]);
});

test('KB role policy merge adds only the fixed public-prefix read and preserves other statements', () => {
  const current = { Version: '2012-10-17', Statement: [{ Sid: 'Existing', Effect: 'Allow', Action: ['bedrock:InvokeModel'], Resource: '*' }] };
  const merged = mergePublicReadStatement(current);
  assert.equal((merged.Statement as unknown[]).length, 2);
  const added = (merged.Statement as any[]).find((statement) => statement.Sid === 'CompanySharedPublicRead');
  assert.deepEqual(added, expectedPublicReadStatement());
  assert.equal(policyHasExpectedPublicRead(merged), true);
  assert.throws(() => mergePublicReadStatement({ Statement: [{ Sid: 'CompanySharedPublicRead', Effect: 'Allow', Action: '*', Resource: '*' }] }), /existing_public_read_statement_conflict/);
});

test('only the gateway task role in the production account is accepted, and only the configured public KB/DS are dedicated', () => {
  assert.equal(runtimeTaskRoleArnMatches(AWS_ADMIN_ACCOUNT_ID, `arn:aws:sts::${AWS_ADMIN_ACCOUNT_ID}:assumed-role/${AWS_ADMIN_TASK_ROLE_NAME}/task-1`), true);
  assert.equal(runtimeTaskRoleArnMatches(AWS_ADMIN_ACCOUNT_ID, `arn:aws:sts::${AWS_ADMIN_ACCOUNT_ID}:assumed-role/OtherRole/task-1`), false);
  assert.equal(isDedicatedPublicKb(AWS_ADMIN_PUBLIC_KB_ID, AWS_ADMIN_PUBLIC_DATA_SOURCE_ID), true);
  assert.equal(isDedicatedPublicKb('ABCDEFGHIJ', 'KLMNOPQRST'), false);
  assert.equal(isDedicatedPublicKb(AWS_ADMIN_MIXED_KB_ID, AWS_ADMIN_PUBLIC_DATA_SOURCE_ID), false);
  assert.equal(isDedicatedPublicKb(AWS_ADMIN_PUBLIC_KB_ID, AWS_ADMIN_MIXED_DATA_SOURCE_ID), false);
});
