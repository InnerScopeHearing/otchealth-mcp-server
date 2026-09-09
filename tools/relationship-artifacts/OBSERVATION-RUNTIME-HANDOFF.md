# Prepared-source observation runtime

The ordinary `full-backfill-cli.mjs` launcher now composes `createObservationReview` from the configured CTO checkout for candidate-only mode. The checkout must contain CTO PR203 (`f68f5dc50262ef542f17c3f3e47c3d176129c391` or a descendant). A missing observation module fails startup rather than silently using the older reviewer.

The existing prepared-text worker and operation reconciler produce source-bound extractor candidates. The existing catalog extraction loader feeds those candidates into observation review. The existing publication pipeline retains the returned immutable artifact reference in its reviewed outbox record, publishes it to the authenticated gateway history ledger, and retries uncertain publication through its existing recovery path. Existing paged retrieval consumes those retained references. No parallel ledger or new query API is introduced.

Candidate-only mode supplies the real operation store but uses no identity signer or model-review dispatch. The extraction model remains separately configured and requires the representative source-grounded quality gate before expansion. Signed review behavior is unchanged.

Three tests passed with both CTO root environment variables bound to the PR203 checkout, including ordinary executable composition and source-cited observation artifact publication followed by reconstructed paged recall. Tests used synthetic source data and actual factories with synthetic network transport. This is not live production acceptance.
