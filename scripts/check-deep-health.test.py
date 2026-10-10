import contextlib
import importlib.util
import io
import os
import sys
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from unittest.mock import patch

MODULE_PATH = Path(__file__).with_name("check-deep-health.py")
spec = importlib.util.spec_from_file_location("check_deep_health", MODULE_PATH)
check = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = check
spec.loader.exec_module(check)

IMAGE_TAG = "2432ea27dc292a34c1aea27cc94c536769284cda-fleet-20261010-0341"
IMAGE_MERGE_SHA = "2432ea27dc292a34c1aea27cc94c536769284cda"
TOKEN = "a" * 64
RAW_MARKER = "RAW_RESPONSE_MUST_NOT_BE_LOGGED"
IMAGE_DIGEST = "sha256:" + "b" * 64
TASK_DEFINITION = "otchealth-gateway:201"


class FakeResponse:
    def __init__(self, body, status=200):
        self.body = body if isinstance(body, bytes) else body.encode("utf-8")
        self.status = status

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self, limit):
        return self.body[:limit]


class FakeOpener:
    def __init__(self, responses):
        self.responses = list(responses)
        self.requests = []

    def open(self, request, timeout):
        self.requests.append((request, timeout))
        item = self.responses.pop(0)
        if isinstance(item, BaseException):
            raise item
        return item


def health_body(status="ok", readiness="ready", image_tag=IMAGE_TAG,
                image_digest=IMAGE_DIGEST, task_definition=TASK_DEFINITION):
    return {
        "status": status,
        "readiness": readiness,
        "revision": {
            "image_tag": image_tag,
            "image_digest": image_digest,
            "task_definition": task_definition,
        },
        "operator_detail": RAW_MARKER,
    }


def deep_body():
    return {
        "cosmos": "unconfigured",
        "search": "unconfigured",
        "foundry": "unconfigured",
        "postgres": "ok",
        "opensearch": "ok",
        "openai": "ok",
        "postgres_tls_verify": True,
    }


class DeepHealthWorkflowBehaviorTests(unittest.TestCase):
    def invoke(self, responses, expected_tag=IMAGE_TAG, expected_digest=IMAGE_DIGEST,
               expected_task_definition=TASK_DEFINITION):
        opener = FakeOpener(responses)
        stdout = io.StringIO()
        stderr = io.StringIO()
        with (
            patch.dict(os.environ, {
                "ADMIN_REVOKE_TOKEN": TOKEN,
                "EXPECTED_IMAGE_TAG": expected_tag,
                "EXPECTED_IMAGE_DIGEST": expected_digest,
                "EXPECTED_TASK_DEFINITION": expected_task_definition,
            }),
            patch.object(check.urllib.request, "build_opener", return_value=opener),
            contextlib.redirect_stdout(stdout),
            contextlib.redirect_stderr(stderr),
        ):
            exit_code = check.cli()
        output = stdout.getvalue()
        mask_command = f"::add-mask::{TOKEN}"
        self.assertNotIn(RAW_MARKER, output + stderr.getvalue())
        self.assertNotIn(TOKEN, output.replace(mask_command, ""))
        return exit_code, output, stderr.getvalue(), opener

    def test_healthy_revision_and_deep_health_emit_only_sanitized_receipt(self):
        exit_code, output, errors, opener = self.invoke([
            FakeResponse(__import__("json").dumps(health_body())),
            FakeResponse(__import__("json").dumps(deep_body())),
        ])
        self.assertEqual(exit_code, 0, errors)
        self.assertIn('"result": "ok"', output)
        self.assertIn(f'"image_tag": "{IMAGE_TAG}"', output)
        self.assertIn(f'"image_digest": "{IMAGE_DIGEST}"', output)
        self.assertIn(f'"task_definition": "{TASK_DEFINITION}"', output)
        self.assertEqual(len(opener.requests), 2)
        self.assertEqual(opener.requests[0][0].full_url, f"{check.BASE_URL}/health")
        self.assertEqual(opener.requests[1][0].full_url, f"{check.BASE_URL}/health/deep")
        self.assertEqual(opener.requests[1][0].get_header("Authorization"), f"Bearer {TOKEN}")

    def test_expected_receipt_accepts_plain_merge_sha_and_safe_suffix(self):
        check.validate_expected_receipt(IMAGE_MERGE_SHA, IMAGE_DIGEST, TASK_DEFINITION)
        check.validate_expected_receipt(IMAGE_TAG, IMAGE_DIGEST, TASK_DEFINITION)

    def test_malformed_expected_receipt_inputs_fail_before_network(self):
        cases = (
            ({"expected_tag": "not-a-merge-sha"}, "expected_image_tag_invalid"),
            ({"expected_tag": IMAGE_MERGE_SHA + "-.unsafe"}, "expected_image_tag_invalid"),
            ({"expected_digest": "sha256:" + "G" * 64}, "expected_image_digest_invalid"),
            ({"expected_task_definition": "otchealth-gateway:0"}, "expected_task_definition_invalid"),
            ({"expected_task_definition": "otchealth-gateway:01"}, "expected_task_definition_invalid"),
            ({"expected_task_definition": "other-gateway:201"}, "expected_task_definition_invalid"),
        )
        for overrides, error_code in cases:
            with self.subTest(error_code=error_code, overrides=overrides):
                code, _output, errors, opener = self.invoke([], **overrides)
                self.assertEqual(code, 1)
                self.assertIn(error_code, errors)
                self.assertEqual(opener.requests, [])

    def test_live_receipt_must_match_all_three_expected_values_before_deep_request(self):
        mismatches = (
            (IMAGE_MERGE_SHA + "-different", IMAGE_DIGEST, TASK_DEFINITION, "image_tag_mismatch"),
            (IMAGE_TAG, "sha256:" + "c" * 64, TASK_DEFINITION, "image_digest_mismatch"),
            (IMAGE_TAG, IMAGE_DIGEST, "otchealth-gateway:202", "task_definition_mismatch"),
        )
        for live_tag, live_digest, live_task, error_code in mismatches:
            with self.subTest(error_code=error_code):
                code, output, errors, opener = self.invoke([
                    FakeResponse(__import__("json").dumps(health_body(
                        image_tag=live_tag, image_digest=live_digest, task_definition=live_task,
                    ))),
                ])
                self.assertEqual(code, 1)
                self.assertIn(error_code, errors)
                self.assertEqual(len(opener.requests), 1)
                self.assertNotIn(RAW_MARKER, output + errors)

    def test_degraded_or_not_ready_health_stops_before_authenticated_request(self):
        for status, readiness in (("degraded", "not_ready"), ("ok", "not_ready")):
            with self.subTest(status=status, readiness=readiness):
                code, output, errors, opener = self.invoke([
                    FakeResponse(__import__("json").dumps(health_body(status, readiness))),
                ])
                self.assertEqual(code, 1)
                self.assertIn("health_not_ready", errors)
                self.assertEqual(len(opener.requests), 1)
                self.assertNotIn(RAW_MARKER, output + errors)

    def test_redirect_and_non_200_responses_fail_without_body_leakage(self):
        for status in (302, 503):
            with self.subTest(status=status):
                error = urllib.error.HTTPError(
                    f"{check.BASE_URL}/health",
                    status,
                    "response",
                    {},
                    io.BytesIO(RAW_MARKER.encode()),
                )
                code, output, errors, _opener = self.invoke([error])
                self.assertEqual(code, 1)
                self.assertIn("request_failed", errors)
                self.assertNotIn(RAW_MARKER, output + errors)
        handler = check.NoRedirect()
        request = urllib.request.Request(f"{check.BASE_URL}/health")
        self.assertIsNone(handler.redirect_request(request, None, 302, "Found", {}, "https://example.invalid"))

    def test_oversized_body_fails_without_body_leakage(self):
        code, output, errors, _opener = self.invoke([
            FakeResponse(b"x" * (check.MAX_RESPONSE_BYTES + 1)),
        ])
        self.assertEqual(code, 1)
        self.assertIn("response_too_large", errors)
        self.assertNotIn(RAW_MARKER, output + errors)

    def test_malformed_and_duplicate_json_fail_without_body_leakage(self):
        bodies = (
            f"not-json-{RAW_MARKER}",
            f'{{"status":"ok","status":"degraded","marker":"{RAW_MARKER}"}}',
        )
        for body in bodies:
            with self.subTest(body_kind="duplicate" if "status" in body else "malformed"):
                code, output, errors, _opener = self.invoke([FakeResponse(body)])
                self.assertEqual(code, 1)
                self.assertIn("invalid_json", errors)
                self.assertNotIn(RAW_MARKER, output + errors)


if __name__ == "__main__":
    unittest.main()
