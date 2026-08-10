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

- Fleet-wide `ENABLE_HEYGEN_PROVIDER_WRITES=false` is a mandatory first-key interlock. A credit-consuming provider call is reachable only when this global switch and the exact family switch are both true.
- Every family switch deploys `false`, including prompt-avatar, direct Avatar Video, reference Look, Video Agent, asset, translation, and TTS.
- Dry-run remains live and returns the exact account/plan/two-pool/reset/time snapshot, request hash, conservative upper bound, reserve, and owner-grant claims.
- Owner grants bind request hash, complete billing snapshot/state/time, confirmed balance, reserve, and maximum.
- A single account-scoped Cosmos spend controller serializes Look and direct-video mutations.
- No provider POST is automatically retried after grant consumption.
- Missing post-call balance evidence or an actual debit above the signed maximum leaves the account spend controller in `reconciling`; all later live HeyGen spending fails closed.
- Terminal accepted/rejected operation replay remains readable while writes are disabled.

There is no honest way to make the provider itself enforce a subscription-credit cap through the current API. The working safety path is a conservative approved bound plus a default-off write switch, exact owner grant, account reservation, and post-call reconciliation lock.

## Next action

The hard-stop release is deployed. Do not run another founder test. Any re-enable proposal must first configure the owner approval issuer, deliberately set the global provider-write interlock plus one exact family flag, and separately approve one canary under the revised bound. Kimberly and Mark remain blocked on consent regardless.

## Family Story final-quality profile — Avatar V only

Matt's owner-locked final-quality rule supersedes Avatar IV as a production choice. HeyGen's current v3 model guide calls Avatar V the highest-fidelity motion/lip-sync engine; Avatar IV remains the broad-coverage default. The completed Matthew Avatar IV canary is pipeline validation only.

Official constraints implemented in the `family_story_final` profile:

- explicit `engine.type=avatar_v`;
- `1080p`, `16:9`; Avatar IV/V 4K is currently unavailable;
- owner-selected `photo_avatar` Look as `avatar_id`;
- exact matched private cloned voice;
- natural voice tuning only: speed 1, pitch 0, volume 1, or omitted;
- pause-aware duration: every supported `<break time="Ns"/>` contributes to the cap and requires `support_pause=true` on the exact voice; other markup is rejected;
- no `expressiveness` (Avatar IV-only);
- `motion_prompt` only when an eligible same-group completed Digital Twin reference is present;
- exact live founder group, selected source type/status, explicit accepted consent, voice, and reference eligibility; missing metadata fails closed;
- locked founder IDs or any Look returned from a locked founder group cannot bypass this policy under the `standard` profile;
- exact conservative `max_approved_credits`, not merely a loose ceiling;
- profile, founder, idempotency-key hash, and manifest hash are owner-grant bound with request and billing state even though policy labels are not forwarded to HeyGen;
- new version-2 durable operation records retain final/fallback classification; version-1 terminal records stay readable through a replay-only legacy comparator and can never open a new submission.

Owner-locked casting:

| Founder | Group | Selected photo Look | Private voice | Personalized-motion reference | Current profile |
|---|---|---|---|---|---|
| Matthew | `81ae4b7368b444d4847ce6f0d3d42674` | `1916ba1b808d49e8829908e29c659469` | `7092904ddda348049fb0eeecf3fdfbb6` | completed same-group Digital Twin `f18ef8e05e564f998b87af7a951fe05a` | `family_story_final` eligible |
| Kimberly | `ad43b5258baf4328a641a59cfebc15c9` | `3c3f4eabdcac4b70baea8ea3299cdc6b` | `551fec783f294caa97696574d7f6d85e` | none; group pending consent | final personalized motion blocked; fallback separately labeled |
| Mark | `319e339d9e3949038f0b7c17c4521f00` | `2a75cc08b7a74baba1ed2a468f796436` | `7a301178c14a49ee9a7deb508d36a1ec` | none; group pending consent | final personalized motion blocked; fallback separately labeled |

Live read-only verification showed all selected photo Looks advertise `avatar_v`. Matthew's photo and Digital Twin reference are completed, in the same group, and the group is completed/accepted. Kimberly and Mark remain `pending_consent/pending`, and group-scoped Digital Twin queries return zero for both.

`family_story_photo_fallback` is an explicit non-equivalent mode for Kimberly or Mark only. It uses Avatar V directly from the selected photo, omits `reference_look_id`, `motion_prompt`, and `expressiveness`, and must never be described as personalized/top-tier motion. The live consent gate still blocks it while the group remains pending. Matthew cannot be downgraded to fallback because he has an eligible reference.

### Avatar V conservative caps

The gateway rounds every positive duration up to a three-second billing bucket and adds the one-credit safety allowance proven by the 591-to-588 incident:

```text
Avatar V cap = ceil(estimated_seconds / 3) + 1
```

Examples: up to 3.000s -> 2; 3.001-6.000s -> 3; 6.001-9.000s -> 4. The observed 4.62367-second canary maps to 3. Family Story requests must set `max_approved_credits` equal to this cap; lower and higher values both fail locally. HeyGen still exposes no provider-enforced cap, so the owner grant, global/family switches, reservation, no-retry rule, and post-call reconciliation lock remain mandatory.

Official sources:

- https://developers.heygen.com/avatar-v
- https://developers.heygen.com/models
- https://developers.heygen.com/reference/create-video
- https://developers.heygen.com/changelog
- https://help.heygen.com/en/articles/15126059-how-to-use-credits-on-heygen