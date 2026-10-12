# Local Developer-context pilot harness

This directory prepares synthetic paired request payloads from the current source implementations and scores provider receipts. It does not authenticate, call an LLM, read protected data, estimate tokens from characters, or prove native-client quotas.

## Prepare the frozen taskset

From the repository root:

```sh
npx tsx scripts/developer-context-pilot/prepare.ts scripts/developer-context-pilot/cases.prepared.json
```

The script builds 24 source fixtures (four per category) and selects 12 pilot pairs (two per category). It constructs baseline startup records using the current `capText` limits and supersession filter, then adds the real full `handleTaskGet` result. The candidate startup uses the actual `buildDeveloperCompactWake` and real metadata `handleTaskGet`; cases that need unavailable task details include a separate full-fetch-answer phase and its full task/events. The selected fixture set currently uses 29 planned logical model completions: 12 baseline, 12 compact-first candidate, and 5 candidate full-fetch follow-ups. Any failed attempt counts against a hard 32-attempt cap. Per-case fixture, instruction, and selected-taskset SHA-256 values are written to the generated JSON. This is a controlled source projection, not a captured registered response, native context window, or observed production traffic. The long detail fixture also pins a current limitation: `capText` caps `text` fields, not task `description` fields, so the full baseline carries that long description and the candidate must retrieve the same full task before answering.

Every request uses the same frozen instruction text, task type `extract`, JSON mode, max output 1024 and high tier. The case-specific user request names the unknown fields to check but never supplies their expected values. The wrapper must use the same configured high-tier model for both arms, record the actual returned model label on every response, and stop the experiment if that label changes. The current gateway may fall back to its configured model label when the provider omits the echo; report that limitation. No invocation changes to the native primary model are proposed.

## Run an already-produced receipt ledger through the scorer

The root-owned caller should write one JSON object per logical attempt. The prepared taskset hash must be attached to every row. Required fields include explicit `unknown_outcomes:0`, `hidden_physical_attempts:"unobservable"`, and cache/deflection booleans so no missing state is treated as zero or false:

```json
{"pair_id":"status_lease-01","arm":"candidate","phase":"compact_first","followup_required":false,"status":"success","taskset_sha256":"<prepared-sha256>","unknown_outcomes":0,"hidden_physical_attempts":"unobservable","returned_model":"<gateway-model-field>","usage":{"prompt_tokens":123,"completion_tokens":20},"quality_pass":true,"critical_failures":[],"cache_hit":false,"deflected":false}
```

For a candidate full-fetch-answer call, use `phase:"full_fetch_answer"` and `followup_triggered_by_fetch:true`. The preceding successful `compact_first` receipt must carry `requested_action:"FETCH_TASK"`; root orchestration then performs the actual `task_get` and supplies that result as the second request. This is stateless API orchestration, not native conversation/tool history. Set `followup_required:true` on every candidate attempt row for that pair. Failed calls also need rows; if the provider gives usage for the failed attempt include it. Missing prompt usage on any attempt blocks acceptance and is never treated as zero. Include optional provider fields verbatim when present: `total_tokens`, `cached_tokens`, and `reasoning_tokens`; optional per-pair and arm totals remain null unless every attempt reports that field. Cache/FAQ paths are not provider completions and block the pair. Keep provider errors sanitized; never include secrets, user data, or raw prompts in this ledger. `unknown_outcomes` is a root-owned reconciliation count across logical calls and must be explicitly zero; hidden physical provider retries remain explicitly unobservable.

Run:

```sh
python3 scripts/developer-context-pilot/score.py receipts.jsonl --cases scripts/developer-context-pilot/cases.prepared.json --out score.json
```

Exit `0` means the bounded logical-gateway pilot gates passed, `1` means the receipt set is incomplete or failed a gate, and `2` means the receipt/manifest could not be read or parsed. The scorer requires exact agreement with the prepared case IDs and taskset hash; every supplied row, including malformed rows, counts toward the 32-attempt cap, and any scoring error blocks acceptance. It includes every logical-attempt prompt token, including candidate full-fetch and reported failed-attempt usage. Acceptance requires 12 complete pairs, at most 32 logical attempts, explicit zero unknown outcomes, a single unchanged returned model label, no candidate critical failure, all 12 baseline and all 12 candidate quality gates passing, aggregate prompt-token reduction of at least 20%, and a weighted paired bootstrap 95% lower bound of at least 20%. A 0/0 quality count cannot pass. The weighting resamples matched pairs and recomputes the ratio of summed candidate to baseline prompt tokens, so a costly regression cannot be hidden by averaging per-case percentages. Total-token reduction including completions is reported separately only when every attempt reports `total_tokens`; missing totals yield no all-token pass and do not imply zero. Hidden physical retries remain unobservable, so acceptance supports only this controlled logical gateway sample. It does not qualify expansion or native usage. The gateway model field may be the configured-label fallback where the provider omits its model echo; report that caveat rather than claiming exact provider echo proof.
