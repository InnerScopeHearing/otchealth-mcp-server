# Successor materialization receipt compatibility

The source-owned CFO materializer now includes the two quarantined operation bindings in its inspection and publication receipt. The gateway previously enforced the older exact receipt shape and rejected that new output. The receipt parser now accepts the bounded optional lineage, includes it in the existing canonical binding digest, and checks the exclusion count and unique source/operation identities.

The completed-publication exclusion manifest is represented by a compact immutable pointer rather than a large inline list. Its exact schema, successor prefix, content-addressed key, version, hash and count are validated. The receipt remains limited to 64 KiB. S3 version syntax now matches the publisher grammar, including plus, slash and tilde characters. These values remain version identifiers, not object keys.

This change does not create an exclusion manifest, reset admissions, activate a cohort or execute a model. Completed-publication source capture and a retained historical publication binding are separate requirements before successor activation. The existing 53 local candidate publication receipts are not proof of full Graph completion.

Validation:

- 30 gateway receipt, controller and publication-source-policy tests passed.
- TypeScript typecheck passed.
- `node --import tsx scripts/verify-successor-materialization-wire.mjs <CTO catalog-materializer directory>` passed against CTO source head `1b7871b47dbf319c8f8e2057d88010d3b9c539b3`, merged by PR289 at `e00df9cea3fe121539f57f5dd6c3ef61c3318206`. This runs the actual Python inspector and source-bound publisher with an in-memory S3 fixture, then verifies the stored 2,402-byte receipt using the actual gateway parser. One synthetic document is eligible and two are excluded. No AWS call or model call occurs.
- Independent worker-side review identified the version grammar mismatch, which was corrected and regression-tested.

The compact completed-manifest pointer has unit coverage; actual completed-manifest worker-to-gateway acceptance remains to be run after that source implementation is ready.
