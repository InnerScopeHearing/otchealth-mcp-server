from __future__ import annotations

import contextlib
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from argparse import Namespace
from pathlib import Path
from unittest.mock import patch


SCRIPT_DIR = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPT_DIR))
import eval_worktree as ew  # noqa: E402


def git(repo: Path, *args: str) -> str:
    result = subprocess.run(["git", "-C", str(repo), *args], text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if result.returncode:
        raise AssertionError(f"git {args} failed: {result.stderr}")
    return result.stdout.strip()


def symlink_or_skip(test: unittest.TestCase, link: Path, target: Path) -> None:
    try:
        link.symlink_to(target, target_is_directory=True)
    except OSError as exc:
        if os.name == "nt" and getattr(exc, "winerror", None) == 1314:
            test.skipTest("Windows symlink privilege unavailable (winerror 1314); coverage skipped")
        raise


class EvalWorktreeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="eval-worktree-test-")
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.control = self.root / "control"
        self.source = self.root / "source"
        self.source.mkdir()
        git(self.source, "init", "-b", "main")
        git(self.source, "config", "user.name", "Synthetic Test")
        git(self.source, "config", "user.email", "synthetic@example.invalid")
        (self.source / "sample.txt").write_text("fixture\n", encoding="utf-8")
        (self.source / ".gitignore").write_text("node_modules/\n.env\n", encoding="utf-8")
        git(self.source, "add", "sample.txt", ".gitignore")
        git(self.source, "commit", "-m", "synthetic fixture")
        self.pin = git(self.source, "rev-parse", "HEAD")
        self.patchers = [
            patch.object(ew, "CONTROL_ROOT", self.control),
            patch.object(ew, "WORKTREE_ROOT", self.control / "worktrees"),
            patch.object(ew, "STATE_ROOT", self.control / "state"),
            patch.object(ew, "ARTIFACT_ROOT", self.control / "artifacts"),
        ]
        for p in self.patchers:
            p.start()
            self.addCleanup(p.stop)

    def prepare(self, run_id: str = "synthetic-run") -> Path:
        with contextlib.redirect_stdout(io.StringIO()):
            ew.cmd_prepare(Namespace(repo=str(self.source), pin=self.pin, run_id=run_id, app="synthetic"))
        return ew.expected_target(run_id)

    def test_rejects_path_escape_and_preserves_outside_target(self) -> None:
        outside = self.root / "escape"
        with self.assertRaises(ew.ContractError):
            ew.expected_target("../escape")
        self.assertFalse(outside.exists())
        self.assertFalse((self.control / "worktrees").exists())

    def test_symlinked_control_and_storage_roots_refuse_without_touching_outside(self) -> None:
        self.control.mkdir()
        for name in ("worktrees", "state", "artifacts"):
            outside = self.root / f"outside-{name}"
            outside.mkdir()
            sentinel = outside / "keep.txt"
            sentinel.write_text("preserve\n", encoding="utf-8")
            link = self.control / name
            symlink_or_skip(self, link, outside)
            with self.subTest(root=name), self.assertRaisesRegex(ew.ContractError, "symlink"):
                ew.cmd_prepare(Namespace(repo=str(self.source), pin=self.pin, run_id=f"symlink-{name}", app="synthetic"))
            self.assertEqual(sentinel.read_text(encoding="utf-8"), "preserve\n")
            self.assertEqual(sorted(p.name for p in outside.iterdir()), ["keep.txt"])
            link.unlink()

        outside_control = self.root / "outside-control"
        outside_control.mkdir()
        (outside_control / "sentinel").write_text("preserve\n", encoding="utf-8")
        link_control = self.root / "control-link"
        symlink_or_skip(self, link_control, outside_control)
        with (
            patch.object(ew, "CONTROL_ROOT", link_control),
            patch.object(ew, "WORKTREE_ROOT", link_control / "worktrees"),
            patch.object(ew, "STATE_ROOT", link_control / "state"),
            patch.object(ew, "ARTIFACT_ROOT", link_control / "artifacts"),
            self.assertRaisesRegex(ew.ContractError, "symlink"),
        ):
            ew.cmd_prepare(Namespace(repo=str(self.source), pin=self.pin, run_id="symlink-control", app="synthetic"))
        self.assertEqual((outside_control / "sentinel").read_text(encoding="utf-8"), "preserve\n")
        self.assertEqual(sorted(p.name for p in outside_control.iterdir()), ["sentinel"])

    def test_load_state_rejects_swapped_worktree_root_symlink(self) -> None:
        target = self.prepare("bound-run")
        moved_root = self.control / "worktrees-real"
        outside = self.root / "outside-worktrees"
        outside.mkdir()
        sentinel = outside / "keep.txt"
        sentinel.write_text("preserve\n", encoding="utf-8")
        ew.WORKTREE_ROOT.rename(moved_root)
        symlink_or_skip(self, ew.WORKTREE_ROOT, outside)
        try:
            with self.assertRaisesRegex(ew.ContractError, "symlink"):
                ew.cmd_cleanup(Namespace(run_id="bound-run"))
            self.assertEqual(sentinel.read_text(encoding="utf-8"), "preserve\n")
            self.assertEqual(sorted(p.name for p in outside.iterdir()), ["keep.txt"])
        finally:
            ew.WORKTREE_ROOT.unlink()
            moved_root.rename(ew.WORKTREE_ROOT)
        self.assertTrue(target.is_dir())

    def test_dirty_source_prestate_is_refused_and_untouched(self) -> None:
        source_file = self.source / "sample.txt"
        source_file.write_text("user change\n", encoding="utf-8")
        before = source_file.read_bytes()
        with self.assertRaisesRegex(ew.ContractError, "source repository has tracked or untracked changes"):
            ew.cmd_prepare(Namespace(repo=str(self.source), pin=self.pin, run_id="dirty-source", app="synthetic"))
        self.assertEqual(source_file.read_bytes(), before)
        self.assertFalse(ew.expected_target("dirty-source").exists())

    def test_wrong_or_non_full_pin_is_refused_before_worktree_creation(self) -> None:
        for bad_pin in ("a" * 39, "f" * 40):
            with self.subTest(pin=bad_pin), self.assertRaises(ew.ContractError):
                ew.cmd_prepare(Namespace(repo=str(self.source), pin=bad_pin, run_id="bad-pin-" + str(len(bad_pin)), app="synthetic"))
        self.assertFalse((self.control / "worktrees").exists())

    def test_manifest_captures_this_invocation_observations_not_prior_verified_handles(self) -> None:
        env = {
            "CODEX_SESSION_ID": "session-from-synthetic-run",
            "CODEX_THREAD_ID": "thread-from-synthetic-run",
            "CODEX_ENVIRONMENT_ID": "environment-from-synthetic-run",
        }
        with (
            patch.dict(os.environ, env),
            patch.object(ew.platform, "system", return_value="SyntheticOS"),
            patch.object(ew.platform, "release", return_value="1.2-test"),
            patch.object(ew.platform, "version", return_value="synthetic-build"),
            patch.object(ew.platform, "machine", return_value="synthetic-machine"),
            patch.object(ew.platform, "python_version", return_value="3.12.synthetic"),
            patch.object(ew.socket, "gethostname", return_value="synthetic-host-a"),
            patch.object(ew.os, "getcwd", return_value=str(self.root)),
            patch.object(ew.os, "getpid", return_value=424242),
            patch.object(ew.sys, "executable", "/synthetic/python"),
        ):
            self.prepare("observed-context")

        manifest = json.loads(ew.state_path("observed-context").read_text(encoding="utf-8"))
        observed = manifest["runtime_observation"]
        self.assertEqual(observed["os"]["system"], "SyntheticOS")
        self.assertEqual(observed["os"]["machine"], "synthetic-machine")
        self.assertEqual(observed["host"]["hostname"], "synthetic-host-a")
        self.assertEqual(observed["cwd"], str(self.root.resolve()))
        self.assertEqual(observed["process"]["pid"], 424242)
        self.assertEqual(observed["process"]["executable"], "/synthetic/python")
        declarations = observed["session_thread_environment_declarations"]
        self.assertEqual(declarations["CODEX_SESSION_ID"]["value"], env["CODEX_SESSION_ID"])
        self.assertEqual(declarations["CODEX_THREAD_ID"]["value"], env["CODEX_THREAD_ID"])
        self.assertEqual(declarations["CODEX_ENVIRONMENT_ID"]["value"], env["CODEX_ENVIRONMENT_ID"])
        self.assertTrue(all(item["verified"] is False for item in declarations.values()))
        self.assertFalse(observed["host"]["verified"])
        self.assertIn("is asserted", observed["interpretation"])
        prior = manifest["prior_verified_provenance"]
        self.assertEqual(prior["session_id"], "01a1048c-b0cb-70a9-9a0c-22ce8e5e4006")
        self.assertNotEqual(declarations["CODEX_SESSION_ID"]["value"], prior["session_id"])

    def test_dirty_worktree_cleanup_refuses_and_preserves_prestate(self) -> None:
        target = self.prepare("dirty-target")
        tracked = target / "sample.txt"
        tracked.write_text("candidate edit\n", encoding="utf-8")
        before = tracked.read_bytes()
        with self.assertRaisesRegex(ew.ContractError, "worktree has user/source state"):
            ew.cmd_cleanup(Namespace(run_id="dirty-target"))
        self.assertTrue(target.is_dir())
        self.assertEqual(tracked.read_bytes(), before)

    def test_unexpected_ignored_file_refuses_cleanup_and_is_preserved(self) -> None:
        target = self.prepare("ignored-data")
        secret_like = target / ".env"
        secret_like.write_text("synthetic-placeholder\n", encoding="utf-8")
        with self.assertRaisesRegex(ew.ContractError, "ignored non-output path"):
            ew.cmd_cleanup(Namespace(run_id="ignored-data"))
        self.assertEqual(secret_like.read_text(encoding="utf-8"), "synthetic-placeholder\n")
        self.assertTrue(target.exists())

    def test_external_runner_logs_survive_exact_clean_worktree_removal(self) -> None:
        target = self.prepare("clean-removal")
        manifest_path = ew.state_path("clean-removal")
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        self.assertEqual(ew.head_sha(target), self.pin)
        self.assertEqual(manifest["pin"], self.pin)
        logs_base = Path(manifest["logs_dir"])
        logs_base.mkdir(parents=True, mode=0o700)
        logs = logs_base / "run-0001"
        logs.mkdir(mode=0o700)
        (logs / "receipt.json").write_text(json.dumps({"exit_status": 0, "fixture": "synthetic"}), encoding="utf-8")
        (logs / "stdout.log").write_text("synthetic fixture pass\n", encoding="utf-8")
        (logs / "stderr.log").write_text("", encoding="utf-8")

        nested_modules = target / "packages" / "app" / "node_modules"
        nested_modules.mkdir(parents=True)
        (nested_modules / "synthetic-cache.txt").write_text("generated\n", encoding="utf-8")
        with contextlib.redirect_stdout(io.StringIO()):
            ew.cmd_cleanup(Namespace(run_id="clean-removal"))
        self.assertFalse(target.exists())
        self.assertTrue(logs_base.exists())
        self.assertTrue(logs.exists())
        self.assertEqual((logs / "stdout.log").read_text(encoding="utf-8"), "synthetic fixture pass\n")
        self.assertEqual(json.loads((logs / "receipt.json").read_text(encoding="utf-8"))["exit_status"], 0)
        self.assertEqual(git(self.source, "rev-parse", "HEAD"), self.pin)
        self.assertEqual(git(self.source, "status", "--porcelain"), "")
        readback = json.loads(manifest_path.read_text(encoding="utf-8"))["cleanup"]
        self.assertTrue(readback["target_absent"])
        self.assertTrue(readback["worktree_list_absent"])
        self.assertTrue(readback["source_checkout_unchanged"])
        self.assertFalse(readback["force_used"])


    def test_remove_failure_receipt_preserves_partial_deregister_residual(self) -> None:
        target = self.prepare("partial-remove")
        logs = ew.ARTIFACT_ROOT / "partial-remove"
        logs.mkdir(parents=True)
        sentinel = logs / "stdout.log"
        sentinel.write_text("preserve\n", encoding="utf-8")
        original_git = ew.git
        attempted = False

        def partial_remove(repo: Path, *args: str, check: bool = True, text: bool = True):
            nonlocal attempted
            if args[:2] == ("worktree", "list") and attempted:
                return subprocess.CompletedProcess(args, 0, stdout=b"", stderr=b"")
            if args[:2] == ("worktree", "remove"):
                attempted = True
                raise ew.ContractError("git remove failed (255): synthetic residual")
            return original_git(repo, *args, check=check, text=text)

        with patch.object(ew, "git", side_effect=partial_remove):
            with self.assertRaisesRegex(ew.ContractError, "residual preserved for owner review"):
                ew.cmd_cleanup(Namespace(run_id="partial-remove"))
        receipt = json.loads(ew.state_path("partial-remove").read_text(encoding="utf-8"))["cleanup"]
        self.assertFalse(receipt["completed"])
        self.assertTrue(receipt["target_present"])
        self.assertFalse(receipt["target_registered_after"])
        self.assertTrue(receipt["worktree_list_absent"])
        self.assertTrue(receipt["source_checkout_unchanged"])
        self.assertTrue(receipt["logs_preserved"])
        self.assertFalse(receipt["force_used"])
        self.assertIn("synthetic residual", receipt["git_remove_error"])
        self.assertTrue(target.is_dir())
        self.assertEqual(sentinel.read_text(encoding="utf-8"), "preserve\n")
        original_git(self.source, "worktree", "remove", str(target))

    def test_ignored_matching_name_requires_an_exact_generated_directory(self) -> None:
        rejected = (b"!! packages/app/node_modules-user/\0", b"!! packages/app/.env\0",
                    b"!! packages/app/dist/private.txt\0", b" M packages/app/source.ts\0")
        for raw in rejected:
            with self.subTest(raw=raw), patch.object(ew, "git", return_value=subprocess.CompletedProcess([], 0, stdout=raw)):
                with self.assertRaises(ew.ContractError):
                    ew.check_cleanup_status(self.root)
        for raw in (b"!! packages/app/node_modules/\0", b"!! packages/app/.turbo/\0"):
            with self.subTest(raw=raw), patch.object(ew, "git", return_value=subprocess.CompletedProcess([], 0, stdout=raw)):
                ew.check_cleanup_status(self.root)

    def test_worktree_registration_matches_complete_paths_not_substrings(self) -> None:
        target = self.root / "target"
        raw = os.fsencode("worktree " + str(target) + "-other") + b"\0HEAD fixture\0\0"
        with patch.object(ew, "git", return_value=subprocess.CompletedProcess([], 0, stdout=raw)):
            self.assertFalse(ew.worktree_is_registered(self.source, target))
        raw = os.fsencode("worktree " + str(target)) + b"\0HEAD fixture\0\0"
        with patch.object(ew, "git", return_value=subprocess.CompletedProcess([], 0, stdout=raw)):
            self.assertTrue(ew.worktree_is_registered(self.source, target))


if __name__ == "__main__":
    unittest.main()
