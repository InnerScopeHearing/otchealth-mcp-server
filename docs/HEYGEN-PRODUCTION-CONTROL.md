# HeyGen Subscription Production Control

## Live status

Phase 0 read discovery and Phase 1 direct Avatar Video production are live in `mcp.otchealth.app`.

- Source: `otchealth-mcp-server` main `555e5fd567d146bfb970616af8a1d90d3bbf9461`
- PR: #197
- PR CI: `31297632789`
- Deployment: `31299016759`
- Live HeyGen catalog: 29 tools, catalog version `c5392855`
- Gateway health after cutover: `status=ok`, `tool_count=943`, writes/high-risk enabled, `dry_run_default=true`
- Live no-render verification: Creator subscription balance 981 before and after; zero credits consumed

## Phase 0 reads

The existing account, video, avatar, voice, and Video Agent style tools are joined by:

- `heygen_video_statuses_get`
- `heygen_video_agent_sessions_list`
- `heygen_video_agent_session_get`
- `heygen_video_agent_session_videos_list`
- `heygen_brand_kits_list`
- `heygen_brand_glossaries_list`
- `heygen_brand_glossary_get`
- `heygen_voice_get`
- `heygen_translation_languages_list`
- `heygen_translations_list`
- `heygen_translation_get`
- `heygen_translation_statuses_get`
- `heygen_proofread_get`
- `heygen_avatar_video_operation_get`

Every provider read runs the subscription guard immediately before the target. Read tools are limited to the exact internal lanes `cto`, `exec`, `coo`, `cro`, `cpo`, and `developer` by both handler and governance.

## Phase 1 direct Avatar Video

`heygen_avatar_video_create` is the only video-generation mutation. It exposes the `type: avatar` branch of `POST /v3/videos`, not the raw provider body.

Required controls:

- caller-supplied `operation_id`, provider `idempotency_key`, and manifest SHA-256;
- explicit avatar look, voice, script, engine, resolution, and aspect ratio;
- exact live subscription-credit snapshot;
- approved maximum credits and reserve floor;
- `confirm_credit_use=true`;
- current look, group, consent, voice, engine, optional reference-look, and parameter compatibility preflight.

Consent normalization is fail-closed. Group status must be exactly `completed`; missing/null group status blocks. A missing/null consent field preserves an avatar path where HeyGen does not require consent. Present consent values are ready only when they case-insensitively equal `accepted`, `approved`, `complete`, or `completed` without surrounding whitespace; `pending`, `pending_consent`, `rejected`, blank, padded, and unknown values block before `POST /v3/videos`. The live Matthew group uses the exact provider value `accepted`; Kimberly and Mark remain blocked at pending consent.

The deterministic Cosmos operation record stores hashes, approval metadata, provider ids/status, and the 24-hour replay boundary. It never stores raw script, title, idempotency key, signed URLs, or upstream response bodies.

The gateway rejects:

- same operation with a changed key, manifest, request, script, approval ceiling, or reserve;
- unsupported engines and engine/look combinations;
- unready look/group/voice or incomplete consent;
- estimated cost above the approved ceiling;
- a ceiling that would cross the reserve floor;
- retries after the provider's 24-hour idempotency window.

Retry rules:

- validation/permission/quota errors: no automatic retry;
- 401: one refresh and same-key replay;
- 409 `request_in_progress`: one bounded same-key replay;
- 429: honor `Retry-After`, then same-key replay;
- 5xx/network: bounded same-key replay;
- malformed 2xx or unpersisted accepted response: `outcome_unknown`, never a new key.

The local credit estimate is conservative and used only as a guard; the provider does not expose a quote/cap endpoint. It is not represented as an exact final charge.

## Poll, ingest, and technical QA

`heygen_video_wait_ingest_qa` requires an accepted durable operation bound to the same video id.

It:

1. polls `GET /v3/videos/{video_id}` for up to 90 seconds per invocation;
2. accepts only terminal completed videos;
3. downloads selected signed assets only from exact `heygen.ai` hosts or subdomains;
4. disables redirects;
5. applies per-asset byte caps and MIME/magic validation;
6. validates SRT cue syntax and monotonic/non-overlapping timing;
7. computes SHA-256;
8. writes assets to the private `heygen-artifacts` Azure Blob container;
9. writes `manifest.json` last as the commit marker;
10. marks operation state `qa_passed` or `qa_failed`.

Technical QA never claims visual quality, likeness accuracy, claim accuracy, brand fit, or release approval. Human review remains mandatory.

## Live no-render receipt

Live reads after deployment returned:

- one known completed video status;
- three Video Agent sessions and a valid session detail;
- four Brand Kits;
- one glossary, `Video Agent Pronunciation`, with five terms;
- Archer voice detail;
- 190 translation languages;
- zero existing translation jobs;
- missing operation lookup returned `found:false`;
- direct-video dry run estimated five seconds and two credits under a five-credit ceiling;
- ingest/QA dry run returned without storage or provider reads;
- a non-dry-run create with `confirm_credit_use=false` failed before any provider call.

Account balance remained 981 before and after.

## Test receipt

Exact PR head `e0426abc98eda1dc53f75c5cce27c5547a01c17c`:

- frozen dependency install: pass;
- typecheck: pass;
- build: pass;
- tests: 1,175/1,175 pass;
- CodeQL: pass;
- Code Quality: pass;
- targeted changed-file secret scan: zero hits.

Deployment `31299016759` passed immutable build, digest resolution, green-at-zero, catalog guard, deep health, 100% cutover, revision pruning, and golden-case eval. Rollback was skipped because every gate passed.

## 2026-08-10 credit-gate incident and hard stop

This section supersedes the earlier readiness and retry language above.

Owner-approved operation `family_matt_test_20260809` created video `7320cf45b5e24974ac631c4f84bb171d` through direct Avatar IV at 1080p/16:9. The local dry run estimated six seconds and two credits, and the signed live request capped approval at two. The provider completed a 4.62367-second video, but the subscription balance moved from 591 to 588: an actual three-credit debit.

Confirmed technical output: completed, transcript exact, Matthew-only canary. Kimberly and Mark were not generated.

### Root cause and revised bound

Published subscription guidance says one credit per three seconds for Avatar IV/V, but does not publish rounding or fixed per-request overhead. The observed provider debit is consistent with the published duration charge plus one additional credit of provider/TTS/rounding overhead. Because the API exposes neither a quote nor a provider-enforced spend cap, the gateway must not treat `ceil(duration/3)` as an enforceable maximum.

The conservative local bound is now:

```text
Avatar III: ceil(estimated_seconds / 60 * 3) + 1
Avatar IV/V: ceil(estimated_seconds / 3) + 1
Avatar IV with custom motion: 2 * ceil(estimated_seconds / 3) + 1
```

The extra one credit is a safety allowance derived from the live canary, not a claim about HeyGen's undisclosed internal billing formula. A six-second Avatar IV estimate therefore requires a minimum approved maximum of three credits. A two-credit ceiling fails before provider submission.

### Enforcement

- Every credit-consuming HeyGen switch deploys `false`, including direct Avatar Video.
- Dry-run remains live and returns the exact account/plan/two-pool/reset/time snapshot, request hash, conservative upper bound, reserve, and owner-grant claims.
- Owner grants bind request hash, complete billing snapshot/state/time, confirmed balance, reserve, and maximum.
- A single account-scoped Cosmos spend controller serializes Look and direct-video mutations.
- No provider POST is automatically retried after grant consumption.
- Missing post-call balance evidence or an actual debit above the signed maximum leaves the account spend controller in `reconciling`; all later live HeyGen spending fails closed.
- Terminal accepted/rejected operation replay remains readable while writes are disabled.

There is no honest way to make the provider itself enforce a subscription-credit cap through the current API. The working safety path is a conservative approved bound plus a default-off write switch, exact owner grant, account reservation, and post-call reconciliation lock.

## Next action

Do not run another founder test. Merge, deploy, and verify the hard-stop release first. Then configure the owner approval issuer and separately decide whether to re-enable one exact direct-video canary using the revised bound. Kimberly and Mark remain blocked on consent regardless.