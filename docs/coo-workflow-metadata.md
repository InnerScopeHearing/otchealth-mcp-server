# COO workflow metadata reader

`n8n_coo_workflow_metadata` is restricted to the authenticated COO role. It reads at most two server-scoped workflow IDs per call and returns only ID, active state and timestamps. It does not list the instance or return workflow definitions, names, credentials or executions.

The reader is unavailable until `COO_N8N_WORKFLOW_ID_ALLOWLIST` contains 1 to 25 unique workflow IDs from a current, authoritative COO operations source. Missing, empty or invalid scope fails before an n8n request. Configure or update that nonsecret policy value through the existing gateway deployment configuration, preserving source evidence and role boundaries. Do not infer scope from an old export or retry an unresolved export. User authorization for this rollout is already recorded; this document does not add an approval step.

A tool listing or an unset configuration does not establish live workflow access. Verify the exact COO caller, configured scope and downstream response before claiming acceptance.