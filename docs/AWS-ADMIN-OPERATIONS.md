# CTO bounded AWS operations

`aws_api_query` and `aws_api_operation` are a fixed operation registry, not an arbitrary AWS request proxy. Both require caller lane `cto` and verify the gateway's AWS identity with STS on every invocation. The only accepted server identity is account `900915535335` and assumed role `otchealthTaskRole`.

Writes remain off unless all of these are true: the gateway request is not a dry run, the global write and high-risk gates permit the operation, and `AWS_ADMIN_ENABLE_WRITES=true`. Only the ECS force-new-deployment operation additionally requires `confirm_live=true`. S3 publication and Bedrock/IAM writes use their fixed content, resource, trust, and merge guards without a separate confirmation prompt. The handlers do not accept AWS credentials, arbitrary ARNs, endpoints, API actions, policy documents, S3 keys, task definitions, or desired counts.

## Fixed operation scope

- S3 is pinned to bucket `otchealth-finance-legal-dr-55c84f6b`, prefix `graph-trial/20260913/managed-graphrag/company_shared/`, and the two source IDs and SHA-256 values in `src/tools/aws-admin/policy.ts`. Reads and versions resolve only those IDs. A put accepts only the exact expected text hash, uses create-only `If-None-Match: *`, requires a returned S3 version ID, and never overwrites an existing key.
- Bedrock reads and ingestion bind to managed knowledge base `ZAYEKIX0RX` and data source `QQX6QE7RA8`. The environment cannot redirect the target. Ingestion preflight requires the exact two `.txt` documents at their pinned S3 versions and verifies each content hash. Matching `.metadata.json` sidecars may exist, but are optional and not inspected or required. Any other object in the fixed prefix refuses ingestion. Ingestion status returns AWS document and metadata counters when present and `null` when AWS omits a counter; it does not infer metadata coverage.
- Data-source update is a no-op when this managed connector already has the exact public-only S3 scope. It refuses other managed connectors and any mixed/non-public source. For a classic S3 connector, it can only narrow the exact bucket's empty prefix list to the one public prefix.
- IAM policy reads and the optional policy merge target only role `otchealth-company-shared-managed-kb-20260928` and inline policy `PublicOnlyManagedKB`. The write refuses unless the role trust has Bedrock as the sole allowed principal type and service, the exact source account, and the exact knowledge-base ARN. It adds only `s3:GetObject` on the fixed public prefix and preserves existing statements. It never attaches policy to `otchealthTaskRole` or uses `iam:PassRole`/`AssumeRole`.
- IAM simulation uses the KB execution role for fixed S3 data-source access checks, and the gateway task role `otchealthTaskRole` for Bedrock, IAM, and ECS API checks. In particular, `bedrock:Retrieve` is simulated only against the exact public KB ARN `arn:aws:bedrock:us-east-1:900915535335:knowledge-base/ZAYEKIX0RX` and the gateway task role.
- ECS reads target cluster `otchealth`, service `otchealth-gateway`, and task-definition family `otchealth-gateway`. The only ECS write is a `forceNewDeployment` request on that existing service and it requires `confirm_live=true`. Its response means restart requested, not deployment complete. It cannot register a task definition, change its role, desired count, image, or environment.

## Gateway task-role permissions

The gateway task role must be provisioned separately with only the service actions and resource constraints needed for this allowlist:

- STS `GetCallerIdentity`.
- S3 `ListBucket` and `ListBucketVersions` on the fixed bucket, constrained to the fixed prefix; `GetObject` and `GetObjectVersion` for the two fixed document keys; `PutObject` for those same keys only if create-only source publication is enabled.
- Bedrock `GetKnowledgeBase`, `ListDataSources`, `GetDataSource`, `ListIngestionJobs`, `GetIngestionJob`, `UpdateDataSource`, and `StartIngestionJob`, restricted to the fixed knowledge base and data source.
- IAM `GetRole`, `GetRolePolicy`, `SimulatePrincipalPolicy`, and, only when the policy merge operation is enabled, `PutRolePolicy` on the one fixed managed-KB execution role.
- ECS `DescribeServices`, `DescribeTaskDefinition`, and, only when the explicitly confirmed restart operation is enabled, `UpdateService` on the fixed gateway service.

This admin router does not call `Retrieve`. Its simulator checks the gateway task role for `bedrock:Retrieve` on the fixed public knowledge base. If the separate public-only retrieval tool uses this same gateway task role, grant `bedrock:Retrieve` there as a distinct exact-resource permission and validate its live results independently.

This PR does not change or attach IAM permissions to the running gateway task role. The rollout owner must verify the effective task-role policy before enabling writes. The fixed handler allowlist is defense in depth, not a substitute for least-privilege IAM.
