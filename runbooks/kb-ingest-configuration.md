# OneDrive ingest configuration

`kb_ingest_drive_file` checks the caller's executive ring and own-role source
folder before configuration or storage access. Preserve those gates.

The original `written:false, error:"unconfigured"` failure required an Azure
SharedKey even when `BLOB_BACKEND=s3`. PR #306 fixed the configuration gate and
the `putBlobRaw` routing for `cfo-source-docs`. Do not restore Azure credentials
to repair the migrated S3 path.

Configuration path:

1. `driveConfigured()` requires the Graph configuration.
2. `loadEnv()` defaults `BLOB_BACKEND` to `s3` and
   `AZURE_CFO_STORAGE_ACCOUNT` to `otchealthcfodata`. That legacy account name
   is a storage mapping identifier, not an Azure endpoint connection.
3. S3 mode does not require `AZURE_CFO_STORAGE_KEY`. The account/container
   allow-list in `s3LocationFor()` determines the destination.
4. `putBlobRaw()` routes this container through the signed S3 helper,
   preserving conditional writes and the existing overwrite default.

The additive `configuration_component` field distinguishes `graph_drive`
from `finance_storage` when `error` is `unconfigured`. It contains no
configuration values. Existing error codes remain compatible. It does not
prove downstream credentials or permissions work.

## Read-only verification, 2026-09-08 UTC

- Authenticated `catalog_probe`, correlation
  `4cec0fc4-326b-4801-bb62-ac3ba370f261`, reported revision 57 and image
  `962efb2`, digest
  `sha256:db2397b4952efb96b4634ffd60f27fc5df2b383ee261786068df22e222c6ecfc`.
- ECS DescribeServices and DescribeTaskDefinition independently reported
  revision 57, two running service tasks, `BLOB_BACKEND=s3`, and all four
  Graph configuration entries present. Only names and presence booleans were
  inspected for credential configuration. Secret values were not retrieved.
- Source at the live image tag contains PR #306's backend-aware configuration
  gate. The account identifier comes from the application default; the live
  task has no account override or Azure key reference.
- Brain `cto__20260907-041` records CFO-reported write/hash acceptance on
  revision 55. This investigation did not repeat that operation or read any
  financial documents. OCR completeness is a separate concern.

Validation: 15 focused synthetic handler tests and TypeScript typecheck passed.
The tests cover both dry-run modes for configuration failures, S3 without an
Azure key, missing source, ring/folder refusal, and overwrite behavior.

This follow-up changes diagnostics only and is not deployed by opening the PR.
The live metadata checks establish configuration and release state, not a new
end-to-end CFO ingestion acceptance. A future CFO-lane check can use
`dry_run:true` with a fresh nonexistent filename in an approved source folder
and a fresh destination path. Expect `written:false` with no `unconfigured`
error and a missing-source summary. Never borrow another lane's credentials.
