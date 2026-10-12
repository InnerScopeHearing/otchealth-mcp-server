#!/usr/bin/env python3
"""Score a local paired Developer-context pilot receipt stream; never calls a provider."""
from __future__ import annotations

import argparse
import json
import random
import sys
from collections import defaultdict
from pathlib import Path

SEED = 20261012
BOOTSTRAP_DRAWS = 10_000


def percentile(sorted_values: list[float], q: float) -> float:
    if not sorted_values:
        raise ValueError("empty percentile input")
    i = (len(sorted_values) - 1) * q
    lo, hi = int(i), min(int(i) + 1, len(sorted_values) - 1)
    return sorted_values[lo] + (sorted_values[hi] - sorted_values[lo]) * (i - lo)


def score(rows: list[dict], expected_pair_ids: list[str], taskset_sha256: str) -> dict:
    errors: list[str] = []
    receipt_contract_ok = True
    attempts: dict[tuple[str, str], list[dict]] = defaultdict(list)
    unexpected_pair_ids = set()
    for n, row in enumerate(rows, 1):
        pair_id, arm = row.get("pair_id"), row.get("arm")
        if not isinstance(pair_id, str) or arm not in ("baseline", "candidate"):
            receipt_contract_ok = False
            errors.append(f"row {n}: pair_id/arm invalid")
            continue
        if pair_id not in expected_pair_ids:
            receipt_contract_ok = False
            unexpected_pair_ids.add(pair_id)
            errors.append(f"row {n}: unexpected pair_id")
        if row.get("taskset_sha256") != taskset_sha256:
            receipt_contract_ok = False
            errors.append(f"row {n}: missing or mismatched taskset_sha256")
        if type(row.get("unknown_outcomes")) is not int or row["unknown_outcomes"] != 0:
            receipt_contract_ok = False
            errors.append(f"row {n}: unknown_outcomes receipt must explicitly equal zero")
        if row.get("hidden_physical_attempts") != "unobservable":
            receipt_contract_ok = False
            errors.append(f"row {n}: hidden_physical_attempts must explicitly be marked unobservable")
        if type(row.get("cache_hit")) is not bool or type(row.get("deflected")) is not bool:
            receipt_contract_ok = False
            errors.append(f"row {n}: cache_hit and deflected must be explicit booleans")
        attempts[(pair_id, arm)].append(row)

    seen_pair_ids = {pair_id for pair_id, _ in attempts}
    missing_pair_ids = set(expected_pair_ids) - seen_pair_ids
    for pair_id in sorted(missing_pair_ids):
        errors.append(f"missing expected pair_id: {pair_id}")
    pair_ids = sorted(seen_pair_ids)
    pair_results = []
    model_labels = set()
    total_tokens = {"baseline": 0, "candidate": 0}
    total_completion = {"baseline": 0, "candidate": 0}
    total_cached = {"baseline": 0, "candidate": 0}
    total_reasoning = {"baseline": 0, "candidate": 0}
    total_provider_total = {"baseline": 0, "candidate": 0}
    field_seen = {name: {"baseline": 0, "candidate": 0} for name in ("completion_tokens", "cached_tokens", "reasoning_tokens", "total_tokens")}
    usage_complete = True
    quality_pass_counts = {"baseline": 0, "candidate": 0}
    critical_regressions = []
    paired_prompt_tokens = []

    for pair_id in pair_ids:
        per_arm = {}
        pair_ok = True
        for arm in ("baseline", "candidate"):
            calls = attempts.get((pair_id, arm), [])
            if not calls:
                pair_ok = usage_complete = False
                errors.append(f"{pair_id}: missing {arm} attempt")
                continue
            prompt = completion = cached = reasoning = total = 0
            pair_field_seen = {name: 0 for name in field_seen}
            arm_models = set()
            expected_followup = any(call.get("followup_required") is True for call in calls)
            if arm == "candidate" and (any(type(call.get("followup_required")) is not bool for call in calls) or len({call.get("followup_required") for call in calls}) != 1):
                pair_ok = False
                errors.append(f"{pair_id}/candidate: followup_required must be consistent on every attempt")
            phases = [call.get("phase") for call in calls]
            success_calls = [call for call in calls if call.get("status") == "success"]
            success_phases = [call.get("phase") for call in success_calls]
            if arm == "baseline" and success_phases.count("answer") != 1:
                pair_ok = False
                errors.append(f"{pair_id}/baseline: expected exactly one successful answer phase")
            if arm == "candidate":
                if success_phases.count("compact_first") != 1:
                    pair_ok = False
                    errors.append(f"{pair_id}/candidate: exactly one successful compact_first phase is required")
                followup_count = success_phases.count("full_fetch_answer")
                if followup_count != (1 if expected_followup else 0):
                    pair_ok = False
                    errors.append(f"{pair_id}/candidate: full-fetch follow-up count does not match fixture requirement")
                if followup_count and not any(call.get("status") == "success" and call.get("phase") == "compact_first" and call.get("requested_action") == "FETCH_TASK" for call in calls):
                    pair_ok = False
                    errors.append(f"{pair_id}/candidate: full-fetch call lacks preceding successful FETCH_TASK action")
                if followup_count and not any(call.get("status") == "success" and call.get("phase") == "full_fetch_answer" and call.get("followup_triggered_by_fetch") is True for call in calls):
                    pair_ok = False
                    errors.append(f"{pair_id}/candidate: follow-up lacks FETCH_TASK action receipt")
            for call in calls:
                status = call.get("status")
                usage = call.get("usage")
                if status not in ("success", "failed"):
                    usage_complete = pair_ok = False
                    errors.append(f"{pair_id}/{arm}: attempt status must be success or failed")
                if not isinstance(usage, dict) or type(usage.get("prompt_tokens")) is not int or usage["prompt_tokens"] < 0:
                    usage_complete = pair_ok = False
                    errors.append(f"{pair_id}/{arm}: attempt has missing or invalid prompt usage")
                    continue
                prompt += usage["prompt_tokens"]
                for field, target in (("completion_tokens", "completion"), ("cached_tokens", "cached"), ("reasoning_tokens", "reasoning"), ("total_tokens", "total")):
                    value = usage.get(field)
                    if value is not None and (type(value) is not int or value < 0):
                        usage_complete = pair_ok = False
                        errors.append(f"{pair_id}/{arm}: invalid {field}")
                    elif value is not None:
                        field_seen[field][arm] += 1
                        pair_field_seen[field] += 1
                        if target == "completion": completion += value
                        elif target == "cached": cached += value
                        elif target == "reasoning": reasoning += value
                        elif target == "total": total += value
                model = call.get("returned_model")
                if status == "success":
                    if isinstance(model, str) and model:
                        arm_models.add(model)
                        model_labels.add(model)
                    else:
                        pair_ok = False
                        errors.append(f"{pair_id}/{arm}: successful response has no returned model label")
                if call.get("cache_hit") or call.get("deflected"):
                    pair_ok = False
                    errors.append(f"{pair_id}/{arm}: cache/FAQ path is not a provider completion")
                if status == "success" and call.get("critical_failures"):
                    critical_regressions.extend({"pair_id": pair_id, "arm": arm, "failure": x} for x in call["critical_failures"])
            if len(arm_models) != 1:
                pair_ok = False
                errors.append(f"{pair_id}/{arm}: model changed across attempts")
            final_phase = "answer" if arm == "baseline" else ("full_fetch_answer" if expected_followup else "compact_first")
            quality_call = next((call for call in reversed(calls) if call.get("status") == "success" and call.get("phase") == final_phase), {})
            quality_ok = quality_call.get("quality_pass") is True and not quality_call.get("critical_failures")
            if quality_ok:
                quality_pass_counts[arm] += 1
            attempt_receipts = []
            for call in calls:
                usage = call.get("usage") if isinstance(call.get("usage"), dict) else {}
                attempt_receipts.append({
                    "phase": call.get("phase"), "status": call.get("status"),
                    "prompt_tokens": usage.get("prompt_tokens"),
                    "completion_tokens": usage.get("completion_tokens"),
                    "total_tokens": usage.get("total_tokens"),
                    "cached_tokens_subset_of_prompt": usage.get("cached_tokens"),
                    "reasoning_tokens": usage.get("reasoning_tokens"),
                    "returned_model": call.get("returned_model"),
                    "cache_hit": bool(call.get("cache_hit")), "deflected": bool(call.get("deflected")),
                    "followup_triggered_by_fetch": bool(call.get("followup_triggered_by_fetch")),
                })
            per_arm[arm] = {"attempts": len(calls), "attempt_receipts": attempt_receipts, "prompt_tokens": prompt, "completion_tokens_reported_sum": completion if pair_field_seen["completion_tokens"] == len(calls) else None, "total_tokens_reported_sum": total if pair_field_seen["total_tokens"] == len(calls) else None, "cached_tokens_reported_sum_subset_of_prompt": cached if pair_field_seen["cached_tokens"] == len(calls) else None, "reasoning_tokens_reported_sum": reasoning if pair_field_seen["reasoning_tokens"] == len(calls) else None, "returned_model": next(iter(arm_models)) if len(arm_models) == 1 else None, "quality_pass": quality_ok, "phases": phases}
            total_tokens[arm] += prompt
            total_completion[arm] += completion
            total_cached[arm] += cached
            total_reasoning[arm] += reasoning
            total_provider_total[arm] += total
        if set(per_arm) == {"baseline", "candidate"}:
            if per_arm["baseline"]["returned_model"] != per_arm["candidate"]["returned_model"]:
                pair_ok = False
                errors.append(f"{pair_id}: baseline/candidate model mismatch")
            b, c = per_arm["baseline"]["prompt_tokens"], per_arm["candidate"]["prompt_tokens"]
            if b <= 0:
                pair_ok = False
                errors.append(f"{pair_id}: baseline prompt token count must be positive")
            elif pair_ok:
                paired_prompt_tokens.append((b, c))
        else:
            pair_ok = False
        pair_results.append({"pair_id": pair_id, "complete_pair": pair_ok, "arms": per_arm})

    if paired_prompt_tokens:
        rng = random.Random(SEED)
        boot = []
        for _ in range(BOOTSTRAP_DRAWS):
            draw = rng.choices(paired_prompt_tokens, k=len(paired_prompt_tokens))
            baseline_sum = sum(pair[0] for pair in draw)
            candidate_sum = sum(pair[1] for pair in draw)
            boot.append(1 - candidate_sum / baseline_sum if baseline_sum else float('-inf'))
        boot.sort()
        point_reduction = 1 - total_tokens["candidate"] / total_tokens["baseline"] if total_tokens["baseline"] else None
        lower = percentile(boot, 0.025)
        upper = percentile(boot, 0.975)
    else:
        point_reduction = lower = upper = None

    same_model = len(model_labels) == 1 and all(p["complete_pair"] for p in pair_results)
    quality_ok = sum(1 for p in critical_regressions if p["arm"] == "candidate") == 0 and quality_pass_counts["baseline"] == 12 and quality_pass_counts["candidate"] == 12
    no_worse_passes = quality_pass_counts["candidate"] >= quality_pass_counts["baseline"]
    enough_pairs = len(pair_results) == 12 and all(p["complete_pair"] for p in pair_results)
    call_cap_ok = len(rows) <= 32
    exact_taskset = not missing_pair_ids and not unexpected_pair_ids and set(pair_ids) == set(expected_pair_ids)
    if not exact_taskset:
        errors.append("receipt pair IDs do not exactly match the prepared taskset")
    if not call_cap_ok:
        errors.append("successful and failed logical inference attempts exceed the 32-call pilot cap")
    input_point_gate = point_reduction is not None and point_reduction >= 0.20
    input_lcb_gate = lower is not None and lower >= 0.20
    all_token_complete = all(field_seen["total_tokens"][arm] == sum(len(v) for (pair_id, arm_key), v in attempts.items() if arm_key == arm) for arm in total_tokens) and not errors
    all_token_reduction = 1 - total_provider_total["candidate"] / total_provider_total["baseline"] if all_token_complete and total_provider_total["baseline"] else None
    all_token_point_gate = all_token_reduction >= 0.20 if all_token_reduction is not None else None
    logical_unknowns_zero = all(type(row.get("unknown_outcomes")) is int and row["unknown_outcomes"] == 0 for row in rows)
    accepted = bool(receipt_contract_ok and not errors and exact_taskset and enough_pairs and call_cap_ok and usage_complete and logical_unknowns_zero and same_model and quality_ok and no_worse_passes and input_point_gate and input_lcb_gate)
    return {
        "schema": "DEVELOPER_CONTEXT_PILOT_SCORE_V1",
        "pair_count": len(pair_results),
        "expected_pair_count": len(expected_pair_ids),
        "expected_pair_ids": expected_pair_ids,
        "taskset_sha256": taskset_sha256,
        "successful_logical_call_budget": 32,
        "attempts_included": len(rows),
        "returned_model_labels": sorted(model_labels),
        "provider_usage_complete_for_every_attempt": usage_complete,
        "physical_attempt_usage": "unobservable; acceptance is limited to the recorded logical gateway pilot and does not support native or expanded physical-attempt claims",
        "logical_attempt_unknown_outcomes_zero": logical_unknowns_zero,
        "receipt_contract_pass": receipt_contract_ok,
        "token_totals": {arm: {"prompt_tokens": total_tokens[arm], "completion_tokens_reported_sum": total_completion[arm] if field_seen["completion_tokens"][arm] == sum(len(v) for (pair_id, arm_key), v in attempts.items() if arm_key == arm) else None, "completion_attempts_with_usage": field_seen["completion_tokens"][arm], "total_tokens_reported_sum": total_provider_total[arm] if all_token_complete else None, "total_attempts_with_total_tokens": field_seen["total_tokens"][arm], "cached_tokens_reported_sum_subset_of_prompt": total_cached[arm] if field_seen["cached_tokens"][arm] == sum(len(v) for (pair_id, arm_key), v in attempts.items() if arm_key == arm) else None, "cached_attempts_with_usage": field_seen["cached_tokens"][arm], "reasoning_tokens_reported_sum": total_reasoning[arm] if field_seen["reasoning_tokens"][arm] == sum(len(v) for (pair_id, arm_key), v in attempts.items() if arm_key == arm) else None, "reasoning_attempts_with_usage": field_seen["reasoning_tokens"][arm]} for arm in total_tokens},
        "prompt_reduction_point_estimate": point_reduction,
        "weighted_paired_prompt_reduction_95pct_interval": {"lower": lower, "upper": upper, "method": "resample matched pairs and recompute 1 - sum(candidate prompt tokens)/sum(baseline prompt tokens)", "draws": BOOTSTRAP_DRAWS, "seed": SEED},
        "prompt_point_estimate_gate_pass": input_point_gate,
        "prompt_lcb_gate_pass": input_lcb_gate,
        "all_token_reduction_point_estimate": all_token_reduction,
        "all_token_point_gate_pass": all_token_point_gate,
        "all_token_gate_required_for_bounded_acceptance": False,
        "all_token_gate_note": "All-token reduction is reported separately when total_tokens are returned for every attempt; missing total_tokens yields null and never counts as a pass.",
        "candidate_quality_pass_count": quality_pass_counts["candidate"],
        "baseline_quality_pass_count": quality_pass_counts["baseline"],
        "quality_pass_count_not_worse": no_worse_passes,
        "all_12_baseline_and_candidate_quality_gates_pass": quality_ok,
        "critical_regressions": critical_regressions,
        "native_chat_result": "unverified; this API/gateway scorer does not prove native-chat usage or quota",
        "accepted_for_bounded_logical_gateway_pilot_only": accepted,
        "provider_model_identity": "returned llm_azure model field held constant; gateway may fall back to configured model label when provider omits its model echo",
        "blocked_reasons": errors,
        "pairs": pair_results,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("receipt", nargs="?", help="JSONL attempts; stdin when omitted")
    parser.add_argument("--cases", required=True, help="prepared case manifest JSON used to freeze expected pair IDs and taskset hash")
    parser.add_argument("--out", help="write score JSON to this path; stdout by default")
    args = parser.parse_args()
    try:
        source = Path(args.receipt).open(encoding="utf-8") if args.receipt else sys.stdin
        with source:
            rows = [json.loads(line) for line in source if line.strip()]
        manifest = json.loads(Path(args.cases).read_text(encoding="utf-8"))
        expected_ids = [case["pair_id"] for case in manifest["cases"]]
        if len(expected_ids) != manifest.get("taskset_pairs") or len(set(expected_ids)) != len(expected_ids):
            raise ValueError("prepared case manifest has duplicate or inconsistent pair IDs")
        taskset_hash = manifest.get("taskset_sha256")
        if not isinstance(taskset_hash, str) or len(taskset_hash) != 64:
            raise ValueError("prepared case manifest is missing its taskset SHA-256")
        result = score(rows, expected_ids, taskset_hash)
        output = json.dumps(result, sort_keys=True, indent=2) + "\n"
        if args.out:
            Path(args.out).write_text(output, encoding="utf-8")
        else:
            sys.stdout.write(output)
        return 0 if result["accepted_for_bounded_logical_gateway_pilot_only"] else 1
    except (OSError, json.JSONDecodeError, ValueError) as exc:
        print(f"score error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
