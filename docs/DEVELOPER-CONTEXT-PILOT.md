# Developer context pilot

This is an optional Developer-only pilot. No default startup view, primary model, provider, role permissions, or other-role behavior is changed.

## New response views

An authenticated Developer connector can request:

```json
{"tool":"wake","arguments":{"view":"developer_compact"}}
```

The view retains complete selected current status, decisions, corrections, inbox/inbound bodies, memory text, source/timestamp information and existing doctrine. It removes exact duplicate shared-record IDs from `pack.recent` and returns authorized task coordination metadata with an explicit full-fetch-before-action marker. It uses existing retraction filtering and task detail-reader policy. It may still be large if operative records are large; it is not a universal size cap.

```json
{"tool":"task_get","arguments":{"task_id":"<authorized task id>","view":"metadata"}}
```

The metadata view retains allowed coordination fields and, only for existing immutable detail readers, title/artifact/note count. It omits description, note and event bodies and performs no event query. It does not establish approval, pending gates or permission to act. Fetch the same authorized task in full when those details are needed.

```json
{"tool":"task_get","arguments":{"task_id":"<same authorized task id>","view":"full"}}
```

Omitting `view` keeps the existing full/brief paths and default behavior. Non-Developer callers cannot use these new views. The compact wake is not offered to M365 static-auth callers because their existing response ceiling remains authoritative. Source registration does not prove a deployed or native client's tool schema was refreshed.

## Measurement

Use `scripts/developer-context-pilot/prepare.ts` and its README to produce the immutable synthetic cases, then score provider receipts with `score.py`. Preparation uses actual projectors and task handlers with injected synthetic data, and makes no provider calls. Provider execution uses the same configured intelligent high tier, identical settings and question set in both arms. Record actual model labels, input/output/total usage, cache fields when returned, all attempts and necessary full-fetch phases. Keep API results separate from native ChatGPT/Codex token counts and allowance.

The pilot is not a general traffic benchmark. A controlled input reduction does not prove equal subscription savings. Source defaults, actual runtime activation, client adoption, same-model usage and quality each require their own receipt. Unknown usage, mixed models, missing cases/phases and failed correctness/citation assertions block qualification. The20% target is a target until an executed score passes; broad expansion requires a separately powered confirmation.

## Quality and rollback

Contract tests cover current corrections, full operative statements, source/truncation metadata, immutable task readers, inaccessible personal tasks, missing/error results, no event reads for metadata and unchanged defaults. Keep source and permitted full-detail access intact. Optional views can be unused immediately; runtime image rollback must retain the previous task definition and immutable image. Do not delete histories or enable caches/schedulers for this pilot.
