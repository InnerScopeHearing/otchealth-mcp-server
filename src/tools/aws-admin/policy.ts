import { createHash } from 'node:crypto';

export const AWS_ADMIN_REGION = 'us-east-1';
export const AWS_ADMIN_ACCOUNT_ID = '900915535335';
export const AWS_ADMIN_TASK_ROLE_NAME = 'otchealthTaskRole';
export const AWS_ADMIN_BUCKET = 'otchealth-finance-legal-dr-55c84f6b';
export const AWS_ADMIN_PUBLIC_PREFIX = 'graph-trial/20260913/managed-graphrag/company_shared/';
export const AWS_ADMIN_PUBLIC_URI_PREFIX = `s3://${AWS_ADMIN_BUCKET}/${AWS_ADMIN_PUBLIC_PREFIX}`;
export const AWS_ADMIN_KB_ROLE_NAME = 'otchealth-company-shared-managed-kb-20260928';
export const AWS_ADMIN_KB_POLICY_NAME = 'PublicOnlyManagedKB';
export const AWS_ADMIN_MIXED_KB_ID = 'XNMHPUKGDT';
export const AWS_ADMIN_MIXED_DATA_SOURCE_ID = 'UOAUREAQOQ';
export const AWS_ADMIN_PUBLIC_KB_ID = 'ZAYEKIX0RX';
export const AWS_ADMIN_PUBLIC_DATA_SOURCE_ID = 'QQX6QE7RA8';
export const AWS_ADMIN_ECS_CLUSTER = 'otchealth';
export const AWS_ADMIN_ECS_SERVICE = 'otchealth-gateway';
export const MAX_PUBLIC_DOCUMENT_BYTES = 512 * 1024;

/** Only these public PR #737 source IDs and exact content hashes can be read or published. */
export const AWS_ADMIN_PUBLIC_SOURCES = {
  '1ab094b6006bcc487b3e2e78f655ebc0c6628e20ce331a21372cc3c9486b9064': 'dc396114458554139e390f3aac96b74619ae565a81c6e95a8db966eb3876e612',
  'cf198fd8021dfc909fb53778019cf5aaf22b764b4d493ff9993065fdb13b83d6': '0d8965a1e9dc355c002e76ecf910d923ee250549d60e30d8af0e85e9bf3c1285',
} as const;

/** Read back from the versioned pilot bucket on 2026-09-28 before the managed-KB sync. */
export const AWS_ADMIN_PUBLIC_SOURCE_VERSIONS = {
  '1ab094b6006bcc487b3e2e78f655ebc0c6628e20ce331a21372cc3c9486b9064': {
    document: 'HD7rhFzxAa_c5X_dZ7.uZOZKrfsZqR9p',
  },
  'cf198fd8021dfc909fb53778019cf5aaf22b764b4d493ff9993065fdb13b83d6': {
    document: '9YLhF8pXlI.JleMlak5g.3cuo93wacCr',
  },
} as const;

export type PublicSourceId = keyof typeof AWS_ADMIN_PUBLIC_SOURCES;

export function isPublicSourceId(value: string): value is PublicSourceId {
  return Object.hasOwn(AWS_ADMIN_PUBLIC_SOURCES, value);
}

export function expectedPublicSourceHash(sourceId: string): string | null {
  return isPublicSourceId(sourceId) ? AWS_ADMIN_PUBLIC_SOURCES[sourceId] : null;
}

export function sha256Hex(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

export function publicSourceKey(sourceId: string): string | null {
  return isPublicSourceId(sourceId) ? `${AWS_ADMIN_PUBLIC_PREFIX}${sourceId}.txt` : null;
}

export function publicMetadataKey(sourceId: string): string | null {
  const sourceKey = publicSourceKey(sourceId);
  return sourceKey ? `${sourceKey}.metadata.json` : null;
}

export function publicSourceUri(sourceId: string): string | null {
  const key = publicSourceKey(sourceId);
  return key ? `s3://${AWS_ADMIN_BUCKET}/${key}` : null;
}

export function isExpectedPublicUri(value: unknown, sourceId: string): boolean {
  return typeof value === 'string' && value === publicSourceUri(sourceId);
}

export function parsePublicDataSourceScope(value: unknown): 'company_shared' | 'unsafe' {
  const dataSource = value as any;
  const configuration = dataSource?.dataSourceConfiguration;
  const s3 = configuration?.s3Configuration;
  if (configuration?.type === 'MANAGED_KNOWLEDGE_BASE_CONNECTOR' || dataSource?.type === 'MANAGED_KNOWLEDGE_BASE_CONNECTOR') {
    const raw = dataSource?.managedKnowledgeBaseConnectorConfiguration?.connectorParameters;
    let managed: any;
    try { managed = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return 'unsafe'; }
    const connection = managed?.connectionConfiguration;
    const prefixes = managed?.filterConfiguration?.inclusionPrefixes;
    if (
      managed?.type === 'S3' &&
      connection?.bucketName === AWS_ADMIN_BUCKET &&
      connection?.bucketOwnerAccountId === AWS_ADMIN_ACCOUNT_ID &&
      Array.isArray(prefixes) && prefixes.length === 1 && prefixes[0] === AWS_ADMIN_PUBLIC_PREFIX &&
      managed?.metadataFilesPrefix === AWS_ADMIN_PUBLIC_PREFIX &&
      managed?.aclEnabled === false
    ) return 'company_shared';
    return 'unsafe';
  }
  const bucketArn = s3?.bucketArn;
  const prefixes = s3?.inclusionPrefixes;
  if (
    bucketArn === `arn:aws:s3:::${AWS_ADMIN_BUCKET}` &&
    Array.isArray(prefixes) &&
    prefixes.length === 1 &&
    prefixes[0] === AWS_ADMIN_PUBLIC_PREFIX
  ) return 'company_shared';
  return 'unsafe';
}

/**
 * Bedrock writes are allowed only through a data source that is already dedicated to the exact
 * public company_shared prefix. In particular, the existing five-slot KB data source with the
 * company/ prefix can never be repurposed by this tool.
 */
export function canUpdatePublicDataSource(value: unknown): boolean {
  const dataSource = value as any;
  if (parsePublicDataSourceScope(dataSource) === 'company_shared') return true;
  if (dataSource?.dataSourceConfiguration?.type === 'MANAGED_KNOWLEDGE_BASE_CONNECTOR' || dataSource?.type === 'MANAGED_KNOWLEDGE_BASE_CONNECTOR') return false;
  const s3 = dataSource?.dataSourceConfiguration?.s3Configuration;
  if (s3?.bucketArn !== `arn:aws:s3:::${AWS_ADMIN_BUCKET}`) return false;
  const prefixes = s3?.inclusionPrefixes;
  return Array.isArray(prefixes) && (prefixes.length === 0 || (prefixes.length === 1 && prefixes[0] === AWS_ADMIN_PUBLIC_PREFIX));
}

export function isSafePublicSourceSet(keys: readonly string[]): boolean {
  const documents = new Set<string>();
  const optionalMetadataSidecars = new Set<string>();
  for (const sourceId of Object.keys(AWS_ADMIN_PUBLIC_SOURCES)) {
    documents.add(publicSourceKey(sourceId)!);
    optionalMetadataSidecars.add(publicMetadataKey(sourceId)!);
  }
  if (new Set(keys).size !== keys.length) return false;
  const listedDocuments = keys.filter((key) => documents.has(key));
  return listedDocuments.length === documents.size &&
    keys.every((key) => documents.has(key) || optionalMetadataSidecars.has(key));
}

/** A pinned, one-statement addition. Callers can never supply a role, resource, or policy body. */
export function expectedPublicReadStatement(): Record<string, unknown> {
  return {
    Sid: 'CompanySharedPublicRead',
    Effect: 'Allow',
    Action: ['s3:GetObject'],
    Resource: `${AWS_ADMIN_PUBLIC_URI_PREFIX.replace('s3://', `arn:aws:s3:::`)}*`,
  };
}

export function policyHasExpectedPublicRead(policy: unknown): boolean {
  const statements = (policy as any)?.Statement;
  return Array.isArray(statements) && statements.some((statement) =>
    statement?.Sid === 'CompanySharedPublicRead' && statement?.Effect === 'Allow' &&
    (Array.isArray(statement?.Action) ? statement.Action : [statement?.Action]).length === 1 &&
    (Array.isArray(statement?.Action) ? statement.Action : [statement?.Action])[0] === 's3:GetObject' &&
    (Array.isArray(statement?.Resource) ? statement.Resource : [statement?.Resource]).length === 1 &&
    (Array.isArray(statement?.Resource) ? statement.Resource : [statement?.Resource])[0] === expectedPublicReadStatement().Resource,
  );
}

export function mergePublicReadStatement(policy: unknown): Record<string, unknown> {
  const base = policy && typeof policy === 'object' ? { ...(policy as Record<string, unknown>) } : {};
  const current = Array.isArray(base.Statement) ? [...base.Statement as unknown[]] : base.Statement ? [base.Statement] : [];
  const existing = current.find((statement: any) => statement?.Sid === 'CompanySharedPublicRead');
  if (existing && !policyHasExpectedPublicRead({ Statement: [existing] })) {
    throw new Error('existing_public_read_statement_conflict');
  }
  if (!existing) current.push(expectedPublicReadStatement());
  return { Version: '2012-10-17', ...base, Statement: current };
}

export function isDedicatedPublicKb(configuredKbId: string, configuredDataSourceId: string): boolean {
  return configuredKbId === AWS_ADMIN_PUBLIC_KB_ID &&
    configuredDataSourceId === AWS_ADMIN_PUBLIC_DATA_SOURCE_ID;
}

export function runtimeTaskRoleArnMatches(account: string, arn: string): boolean {
  return account === AWS_ADMIN_ACCOUNT_ID && arn.startsWith(`arn:aws:sts::${AWS_ADMIN_ACCOUNT_ID}:assumed-role/${AWS_ADMIN_TASK_ROLE_NAME}/`);
}
