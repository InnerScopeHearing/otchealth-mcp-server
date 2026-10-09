#!/usr/bin/env python3
"""Verify the live AWS gateway's pinned deployment and authenticated deep-health contract.

Only fixed, allowlisted receipt fields are written to stdout. Response bodies and request
exceptions are never logged because /health/deep can contain deployment and dependency details.
"""

import json
import os
import re
import sys
import urllib.error
import urllib.request
from typing import Any

BASE_URL = "https://mcp.otchealth.app"
EXPECTED_IMAGE_DIGEST = "sha256:be9a19ae72378c3dfbeee6ebd3d974c97c185619a4fb71dddf2c53b01704053d"
EXPECTED_TASK_DEFINITION = "otchealth-gateway:199"
DEEP_FIELDS = {
    "cosmos",
    "search",
    "foundry",
    "postgres",
    "opensearch",
    "openai",
    "postgres_tls_verify",
}
DEPENDENCY_FIELDS = ("cosmos", "search", "foundry", "postgres", "opensearch", "openai")
REQUIRED_OK_FIELDS = ("postgres", "opensearch", "openai")
VALID_STATUSES = {"ok", "down", "unconfigured"}
MAX_RESPONSE_BYTES = 65536


class CheckFailure(Exception):
    """A sanitized, user-visible check failure code."""


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, file_pointer, code, message, headers, new_url):
        return None


def reject_duplicate_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    parsed: dict[str, Any] = {}
    for key, value in pairs:
        if key in parsed:
            raise ValueError("duplicate key")
        parsed[key] = value
    return parsed


def get_json(path: str, token: str | None = None) -> dict[str, Any]:
    headers = {"Accept": "application/json"}
    if token is not None:
        headers["Authorization"] = f"Bearer {token}"
    request = urllib.request.Request(f"{BASE_URL}{path}", headers=headers, method="GET")
    opener = urllib.request.build_opener(NoRedirect())

    try:
        with opener.open(request, timeout=10) as response:
            if response.status != 200:
                raise CheckFailure("unexpected_http_status")
            raw = response.read(MAX_RESPONSE_BYTES + 1)
    except CheckFailure:
        raise
    except (urllib.error.URLError, TimeoutError, OSError):
        raise CheckFailure("request_failed") from None

    if len(raw) > MAX_RESPONSE_BYTES:
        raise CheckFailure("response_too_large")
    try:
        value = json.loads(raw, object_pairs_hook=reject_duplicate_keys)
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError):
        raise CheckFailure("invalid_json") from None
    if not isinstance(value, dict):
        raise CheckFailure("invalid_json")
    return value


def verify_revision(payload: dict[str, Any], expected_tag: str) -> None:
    if payload.get("status") != "ok" or payload.get("readiness") != "ready":
        raise CheckFailure("health_not_ready")
    revision = payload.get("revision")
    if not isinstance(revision, dict):
        raise CheckFailure("revision_missing")
    if revision.get("image_tag") != expected_tag:
        raise CheckFailure("image_tag_mismatch")
    if revision.get("image_digest") != EXPECTED_IMAGE_DIGEST:
        raise CheckFailure("image_digest_mismatch")
    if revision.get("task_definition") != EXPECTED_TASK_DEFINITION:
        raise CheckFailure("task_definition_mismatch")


def verify_deep_health(payload: dict[str, Any]) -> dict[str, str]:
    if set(payload) != DEEP_FIELDS:
        raise CheckFailure("deep_fields_mismatch")

    statuses: dict[str, str] = {}
    for field in DEPENDENCY_FIELDS:
        status = payload[field]
        if not isinstance(status, str) or status not in VALID_STATUSES:
            raise CheckFailure("invalid_dependency_status")
        if status == "down":
            raise CheckFailure("dependency_down")
        statuses[field] = status

    for field in REQUIRED_OK_FIELDS:
        if statuses[field] != "ok":
            raise CheckFailure("required_dependency_not_ok")
    if payload["postgres_tls_verify"] is not True:
        raise CheckFailure("postgres_tls_verification_failed")
    return statuses


def main() -> int:
    expected_tag = os.environ.get("EXPECTED_IMAGE_TAG", "")
    if re.fullmatch(r"[0-9a-f]{40}", expected_tag) is None:
        raise CheckFailure("expected_image_tag_invalid")

    token = os.environ.get("ADMIN_REVOKE_TOKEN", "")
    if not token.strip():
        raise CheckFailure("admin_token_missing")
    # ADMIN_REVOKE_TOKEN is generated as 32-byte lowercase hex; constrain it before emitting
    # the Actions masking command so secret content cannot inject another workflow command.
    if re.fullmatch(r"[0-9a-f]{64}", token) is None:
        raise CheckFailure("admin_token_invalid")
    # Register the value with the Actions log masker before making an authenticated request.
    print(f"::add-mask::{token}", flush=True)

    health = get_json("/health")
    verify_revision(health, expected_tag)

    deep = get_json("/health/deep", token=token)
    statuses = verify_deep_health(deep)

    # Deliberately emit only these allowlisted, non-secret fields. Never print either response.
    receipt = {
        "result": "ok",
        "image_tag": expected_tag,
        "image_digest": EXPECTED_IMAGE_DIGEST,
        "task_definition": EXPECTED_TASK_DEFINITION,
        "dependencies": statuses,
        "postgres_tls_verify": True,
    }
    print(json.dumps(receipt, sort_keys=True))
    return 0


def cli() -> int:
    try:
        return main()
    except CheckFailure as failure:
        print(f"::error::Deep-health verification failed: {failure}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(cli())
