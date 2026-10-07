#!/usr/bin/env python3
"""Create, inspect, and safely remove exact local evaluation worktrees.

This utility never creates a remote branch and never force-removes a worktree.
All artifacts and run logs stay outside the evaluated source worktree.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import re
import socket
import stat
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Sequence


# Keep the lexical path so validation can detect a symlinked control root;
# resolving here would erase the evidence before the containment check.
CONTROL_ROOT = Path(__file__).absolute().parents[1]
WORKTREE_ROOT = CONTROL_ROOT / "worktrees"
STATE_ROOT = CONTROL_ROOT / "state"
ARTIFACT_ROOT = CONTROL_ROOT / "artifacts"
RUN_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
SHA_RE = re.compile(r"^[0-9a-fA-F]{40}$")
IGNORED_OUTPUT_ROOTS = (
    "node_modules",
    ".turbo",
    "dist",
    "coverage",
    "playwright-report",
    "test-results",
)
IGNORED_OUTPUT_FILE_SUFFIXES = (".tsbuildinfo",)

# This is provenance from the earlier root-verified review session, not the
# identity of a future invocation. Every new manifest records its own runtime
# observations separately and never inherits these values as current proof.
PRIOR_VERIFIED_PROVENANCE = {
    "verified_utc": "2026-10-04T23:53:16.978Z",
    "verified_by": "root-side independent session/environment binding review",
    "session_id": "01a1048c-b0cb-70a9-9a0c-22ce8e5e4006",
    "environment_id": "ccarenv_b64_Y2NhcmVudl82YTliMGJjN2ExMTA4MTkxYTlmZTJhYTY2MDA4MTJmNQ",
    "hostname": "26772fe82cf9",
    "scope": "Historical provenance only; not evidence for any later prepare invocation.",
}


class ContractError(RuntimeError):
    pass


def require_no_reparse(path: Path) -> Path:
    absolute = Path(os.path.abspath(path))
    for candidate in (*reversed(absolute.parents), absolute):
        try:
            info = candidate.lstat()
        except FileNotFoundError:
            continue
        except OSError as exc:
            raise ContractError(f"cannot validate path attributes: {candidate}") from exc
        if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400):
            raise ContractError(f"reparse or symlink path refused: {candidate}")
    return absolute


def require_logs(data: dict) -> Path:
    expected = require_no_reparse(ARTIFACT_ROOT / data["run_id"])
    recorded = Path(data.get("logs_dir", ""))
    if not recorded.is_absolute() or require_no_reparse(recorded) != expected or not expected.is_dir():
        raise ContractError("exact retained log directory is missing or changed; preserve target")
    return expected


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def observe_runtime() -> dict:
    """Capture this invocation's environment without claiming external verification."""
    declarations = {
        name: {
            "value": os.environ.get(name),
            "source": "invoking process environment declaration",
            "verified": False,
        }
        for name in ("CODEX_SESSION_ID", "CODEX_THREAD_ID", "CODEX_ENVIRONMENT_ID")
    }
    return {
        "observed_utc": utc_now(),
        "os": {
            "system": platform.system(),
            "release": platform.release(),
            "version": platform.version(),
            "machine": platform.machine(),
            "source": "Python runtime platform observation",
        },
        "host": {
            "hostname": socket.gethostname(),
            "source": "local runtime hostname observation; geographic/model hosting not inferred",
            "verified": False,
        },
        "cwd": str(Path(os.getcwd()).resolve()),
        "process": {
            "pid": os.getpid(),
            "executable": sys.executable,
            "python_version": platform.python_version(),
        },
        "session_thread_environment_declarations": declarations,
        "interpretation": "Current process observations and environment declarations only; no independent session, environment, or host binding is asserted.",
    }


def git(repo: Path, *args: str, check: bool = True, text: bool = True) -> subprocess.CompletedProcess:
    result = subprocess.run(
        ["git", "-C", str(repo), *args],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=text,
        check=False,
    )
    if check and result.returncode != 0:
        stderr = result.stderr if text else result.stderr.decode("utf-8", "replace")
        raise ContractError(f"git {' '.join(args)} failed ({result.returncode}): {stderr.strip()}")
    return result


def git_root(path: Path) -> Path:
    result = git(path, "rev-parse", "--show-toplevel")
    return Path(result.stdout.strip()).resolve()


def status_bytes(repo: Path) -> bytes:
    return git(repo, "status", "--porcelain=v1", "--untracked-files=all", "-z", text=False).stdout


def status_digest(repo: Path) -> str:
    return hashlib.sha256(status_bytes(repo)).hexdigest()


def head_sha(repo: Path) -> str:
    return git(repo, "rev-parse", "HEAD").stdout.strip()


def parse_status_paths(raw: bytes) -> list[tuple[str, str]]:
    """Return (status, path) for porcelain -z records (enough for safety gating)."""
    records: list[tuple[str, str]] = []
    for entry in raw.split(b"\0"):
        if not entry:
            continue
        if len(entry) < 4 or entry[2:3] != b" ":
            raise ContractError("unrecognized NUL porcelain status; refusing cleanup")
        code = entry[:2].decode("ascii", "replace")
        path = entry[3:].decode("utf-8", "surrogateescape")
        records.append((code, path))
    return records


def check_run_id(run_id: str) -> None:
    if not RUN_ID_RE.fullmatch(run_id) or run_id in {".", ".."}:
        raise ContractError("run-id must match [A-Za-z0-9][A-Za-z0-9._-]{0,63}")


def state_path(run_id: str) -> Path:
    check_run_id(run_id)
    return STATE_ROOT / f"{run_id}.json"


def validate_control_layout() -> Path:
    """Reject symlinked control roots/ancestors before touching state or targets."""
    control = require_no_reparse(CONTROL_ROOT)
    current = control
    while True:
        if current.is_symlink():
            raise ContractError(f"control path ancestor is a symlink: {current}")
        if current == current.parent:
            break
        current = current.parent

    expected = {
        "worktrees": (WORKTREE_ROOT, control / "worktrees"),
        "state": (STATE_ROOT, control / "state"),
        "artifacts": (ARTIFACT_ROOT, control / "artifacts"),
    }
    for label, (configured, canonical) in expected.items():
        require_no_reparse(configured)
        if Path(os.path.abspath(configured)) != canonical:
            raise ContractError(f"{label} root must be the canonical child {canonical}")
        current = canonical
        while current != control:
            if current.is_symlink():
                raise ContractError(f"{label} path ancestor is a symlink: {current}")
            if current.parent == current:
                raise ContractError(f"{label} root escaped the control directory")
            current = current.parent
    return control


def expected_target(run_id: str) -> Path:
    check_run_id(run_id)
    validate_control_layout()
    return WORKTREE_ROOT / run_id


def write_json(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    tmp = path.with_suffix(path.suffix + ".tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        json.dump(data, handle, indent=2, sort_keys=True)
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(tmp, path)
    os.chmod(path, 0o600)


def load_state(run_id: str) -> tuple[dict, Path]:
    validate_control_layout()
    path = state_path(run_id)
    require_no_reparse(path)
    if path.is_symlink() or not path.is_file():
        raise ContractError(f"No regular evaluation state file for run-id {run_id!r}")
    data = json.loads(path.read_text(encoding="utf-8"))
    target = expected_target(run_id)
    require_no_reparse(target)
    if data.get("run_id") != run_id or Path(data.get("target", "")).resolve() != target.resolve():
        raise ContractError("state does not bind the requested id to its exact contained worktree")
    if target.is_symlink():
        raise ContractError("worktree target is a symlink; refusing operation")
    resolved = target.resolve()
    if resolved.parent != WORKTREE_ROOT.resolve():
        raise ContractError("worktree target escaped the dedicated worktree root")
    source = require_no_reparse(Path(data.get("source_repo", ""))).resolve()
    if not source.is_dir() or git_root(source) != source:
        raise ContractError("recorded source repository is unavailable or changed")
    return data, path


def verify_target(data: dict, target: Path) -> Path:
    require_no_reparse(target)
    if target.is_symlink() or not target.is_dir():
        raise ContractError("exact evaluation worktree is missing or is a symlink")
    root = git_root(target)
    if root != target.resolve():
        raise ContractError("Git worktree root is not the exact recorded target")
    marker = target / ".git"
    if marker.is_symlink() or not marker.is_file():
        raise ContractError("target is not a linked Git worktree")
    pin = data["pin"].lower()
    actual = head_sha(target)
    if actual != pin:
        raise ContractError(f"source pin mismatch: expected {pin}, got {actual}")
    return target


def cmd_prepare(args: argparse.Namespace) -> int:
    validate_control_layout()
    check_run_id(args.run_id)
    repo_arg = Path(args.repo).expanduser()
    require_no_reparse(repo_arg)
    if not repo_arg.exists():
        raise ContractError("source repository path does not exist")
    repo = git_root(repo_arg.resolve())
    pin = args.pin.lower()
    if not SHA_RE.fullmatch(pin):
        raise ContractError("pin must be a full 40-character commit SHA")
    if git(repo, "cat-file", "-e", f"{pin}^{{commit}}", check=False).returncode != 0:
        raise ContractError("pinned commit is not present in the source repository")
    resolved_pin = git(repo, "rev-parse", f"{pin}^{{commit}}").stdout.strip()
    if resolved_pin != pin:
        raise ContractError("pin did not resolve to the supplied full commit SHA")
    before_head = head_sha(repo)
    before_status = status_bytes(repo)
    if before_status:
        raise ContractError("source repository has tracked or untracked changes; preserve and clean it before evaluation")

    target = expected_target(args.run_id)
    manifest = state_path(args.run_id)
    if target.exists() or target.is_symlink() or manifest.exists() or manifest.is_symlink():
        raise ContractError("run-id target or state already exists; refusing to overwrite existing prestate")
    WORKTREE_ROOT.mkdir(parents=True, exist_ok=True, mode=0o700)
    STATE_ROOT.mkdir(parents=True, exist_ok=True, mode=0o700)
    ARTIFACT_ROOT.mkdir(parents=True, exist_ok=True, mode=0o700)
    validate_control_layout()
    if Path(os.path.abspath(target)).parent != Path(os.path.abspath(WORKTREE_ROOT)):
        raise ContractError("derived target escaped the dedicated worktree root")

    git(repo, "worktree", "add", "--detach", str(target), pin)
    try:
        validate_control_layout()
        verify_target({"pin": pin}, target)
        if status_bytes(target):
            raise ContractError("newly created worktree is not clean")
        after_head = head_sha(repo)
        after_status = status_bytes(repo)
        if before_head != after_head or before_status != after_status:
            raise ContractError("source checkout changed during worktree creation; preserve it and stop")
        data = {
            "schema": "isolated-eval-worktree/v1",
            "run_id": args.run_id,
            "app": args.app,
            "source_repo": str(repo),
            "source_head_before": before_head,
            "source_status_sha256_before": hashlib.sha256(before_status).hexdigest(),
            "pin": pin,
            "target": str(target),
            "target_head_after_create": head_sha(target),
            "created_utc": utc_now(),
            "logs_dir": str(ARTIFACT_ROOT / args.run_id),
            "developer_owner": "Developer owns scoped test run and candidate-only work",
            "cleanup_owner": "CTO owns explicitly assigned cleanup; no delete permission is implied",
            "runtime_observation": observe_runtime(),
            "prior_verified_provenance": PRIOR_VERIFIED_PROVENANCE,
        }
        (ARTIFACT_ROOT / args.run_id).mkdir(mode=0o700)
        write_json(manifest, data)
    except Exception:
        # Exact newly-created worktree only; no force option and no recursive deletion.
        if target.exists() and not target.is_symlink():
            try:
                git(repo, "worktree", "remove", str(target))
            except Exception:
                pass
        raise
    print(json.dumps({"created": True, "run_id": args.run_id, "pin": pin, "target": str(target), "manifest": str(manifest)}, indent=2))
    return 0


def cmd_status(args: argparse.Namespace) -> int:
    data, _ = load_state(args.run_id)
    target = expected_target(args.run_id)
    if target.exists():
        verify_target(data, target)
        status = git(target, "status", "--short", "--untracked-files=all").stdout
        result = {"run_id": args.run_id, "pin": head_sha(target), "target": str(target), "status": status, "exists": True}
    else:
        result = {"run_id": args.run_id, "pin": data["pin"], "target": str(target), "exists": False, "cleanup": data.get("cleanup")}
    print(json.dumps(result, indent=2))
    return 0


def worktree_is_registered(repo: Path, target: Path) -> bool:
    """Compare complete native paths in NUL-delimited porcelain output."""
    raw = git(repo, "worktree", "list", "--porcelain", "-z", text=False).stdout
    target_key = os.path.normcase(os.path.abspath(os.fspath(target)))
    for record in raw.split(b"\0"):
        if record.startswith(b"worktree "):
            listed = os.fsdecode(record[len(b"worktree ") :])
            if os.path.normcase(os.path.abspath(listed)) == target_key:
                return True
    return False


def check_cleanup_status(target: Path) -> None:
    raw = git(target, "status", "--porcelain=v1", "--ignored=matching", "--untracked-files=all", "-z", text=False).stdout
    refusals: list[str] = []
    for code, path in parse_status_paths(raw):
        if code == "!!":
            output_dir = path.rstrip("/").rsplit("/", 1)[-1]
            if path.endswith("/") and output_dir in IGNORED_OUTPUT_ROOTS:
                continue
            if not path.endswith("/") and path.rsplit("/", 1)[-1].endswith(IGNORED_OUTPUT_FILE_SUFFIXES):
                continue
            refusals.append(f"ignored non-output path: {path}")
        else:
            refusals.append(f"changed or untracked path: {path} ({code})")
    if refusals:
        raise ContractError("worktree has user/source state; preserved without cleanup: " + "; ".join(refusals[:10]))


def remove_windows_deregistered_residual(target: Path) -> dict:
    """Remove one already-deregistered exact residual through native PowerShell."""
    require_no_reparse(target)
    recovery_env = os.environ.copy()
    recovery_env["OTCHEALTH_CLEANUP_TARGET"] = str(target)
    command = [
        "pwsh", "-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
        "Remove-Item -LiteralPath $env:OTCHEALTH_CLEANUP_TARGET -Recurse -ErrorAction Stop",
    ]
    result = subprocess.run(
        command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        check=False, env=recovery_env,
    )
    return {
        "attempted": True,
        "method": "PowerShell Remove-Item -LiteralPath -Recurse without Force",
        "target": str(target),
        "exit_code": result.returncode,
        "stdout": result.stdout,
        "stderr": result.stderr,
        "force_used": False,
        "completed": result.returncode == 0 and not (target.exists() or target.is_symlink()),
    }


def validate_deregistered_residual(source: Path, target: Path) -> dict:
    """Prove every remaining non-generated byte still matches the exact source."""
    require_no_reparse(source)
    require_no_reparse(target)
    if target.is_symlink() or not target.is_dir():
        raise ContractError("recorded residual is missing, not a directory, or a symlink")
    tracked_raw = git(source, "ls-files", "-z", text=False).stdout
    tracked_files = {
        entry.decode("utf-8", "surrogateescape")
        for entry in tracked_raw.split(b"\0")
        if entry
    }
    digest = hashlib.sha256()
    files_checked = 0
    generated_roots = 0
    def walk_error(error):
        raise ContractError("cannot inventory residual subtree; preserve target") from error

    for current, dirs, files in os.walk(target, topdown=True, onerror=walk_error):
        current_path = Path(current)
        require_no_reparse(current_path)
        rel_dir = current_path.relative_to(target)
        in_generated = any(part in IGNORED_OUTPUT_ROOTS for part in rel_dir.parts)
        kept_dirs: list[str] = []
        for name in sorted(dirs):
            candidate = current_path / name
            require_no_reparse(candidate)
            rel = (rel_dir / name).as_posix()
            if candidate.is_symlink():
                raise ContractError(f"recorded residual contains a symlinked directory: {rel}")
            if name in IGNORED_OUTPUT_ROOTS:
                digest.update(f"generated-dir:{rel}\n".encode())
                generated_roots += 1
                kept_dirs.append(name)
                continue
            if in_generated:
                kept_dirs.append(name)
                continue
            source_dir = source / rel_dir / name
            if not source_dir.is_dir() or source_dir.is_symlink():
                raise ContractError(f"recorded residual contains an unknown directory: {rel}")
            kept_dirs.append(name)
        dirs[:] = kept_dirs
        for name in sorted(files):
            candidate = current_path / name
            require_no_reparse(candidate)
            rel = (rel_dir / name).as_posix()
            if candidate.is_symlink() or not candidate.is_file():
                raise ContractError(f"recorded residual contains a non-regular file: {rel}")
            if in_generated:
                continue
            if name.endswith(IGNORED_OUTPUT_FILE_SUFFIXES):
                digest.update(f"generated-file:{rel}:{candidate.stat().st_size}\n".encode())
                continue
            if rel not in tracked_files:
                raise ContractError(f"recorded residual contains an untracked or ignored file: {rel}")
            source_file = source / rel_dir / name
            if not source_file.is_file() or source_file.is_symlink():
                raise ContractError(f"recorded residual contains an unknown file: {rel}")
            candidate_hash = hashlib.sha256(candidate.read_bytes()).hexdigest()
            source_hash = hashlib.sha256(source_file.read_bytes()).hexdigest()
            if candidate_hash != source_hash:
                raise ContractError(f"recorded residual file no longer matches exact source: {rel}")
            digest.update(f"source-file:{rel}:{candidate_hash}\n".encode())
            files_checked += 1
    return {
        "validated": True,
        "validated_utc": utc_now(),
        "inventory_sha256": digest.hexdigest(),
        "source_files_matched": files_checked,
        "generated_roots": generated_roots,
        "policy": "non-generated regular files must be Git tracked and byte-match exact source; generated roots and *.tsbuildinfo only",
    }


def cmd_cleanup(args: argparse.Namespace) -> int:
    data, manifest = load_state(args.run_id)
    target = expected_target(args.run_id)
    require_no_reparse(target)
    if not target.exists():
        raise ContractError("target already absent; reconcile exact Git readback before another cleanup attempt")
    prior_cleanup = data.get("cleanup")
    if isinstance(prior_cleanup, dict) and prior_cleanup.get("completed") is False:
        repo = Path(data["source_repo"])
        source_head = head_sha(repo)
        source_status = hashlib.sha256(status_bytes(repo)).hexdigest()
        recorded_partial = (
            prior_cleanup.get("target") == str(target)
            and prior_cleanup.get("target_present") is True
            and prior_cleanup.get("target_registered_after") is False
            and prior_cleanup.get("worktree_list_absent") is True
            and prior_cleanup.get("source_checkout_unchanged") is True
            and prior_cleanup.get("force_used") is False
            and isinstance(prior_cleanup.get("git_remove_error"), str)
            and prior_cleanup["git_remove_error"].startswith(f"git worktree remove {target} failed (255):")
        )
        source_still_exact = (
            source_head == data["source_head_before"]
            and source_status == data["source_status_sha256_before"]
        )
        if recorded_partial and source_still_exact and not worktree_is_registered(repo, target) and os.name == "nt":
            require_logs(data)
            residual_validation = validate_deregistered_residual(repo, target)
            prior_cleanup["residual_validation"] = residual_validation
            prior_cleanup["recovery_started_utc"] = utc_now()
            write_json(manifest, data)
            validate_control_layout()
            require_no_reparse(repo)
            require_no_reparse(target)
            require_logs(data)
            recovery = remove_windows_deregistered_residual(target)
            prior_cleanup["residual_recovery"] = recovery
            prior_cleanup["recovery_completed_utc"] = utc_now()
            prior_cleanup["target_present"] = target.exists() or target.is_symlink()
            prior_cleanup["target_absent"] = not prior_cleanup["target_present"]
            prior_cleanup["target_registered_after"] = worktree_is_registered(repo, target)
            prior_cleanup["worktree_list_absent"] = not prior_cleanup["target_registered_after"]
            prior_cleanup["source_head_after"] = head_sha(repo)
            prior_cleanup["source_status_sha256_after"] = hashlib.sha256(status_bytes(repo)).hexdigest()
            prior_cleanup["source_checkout_unchanged"] = (
                prior_cleanup["source_head_after"] == data["source_head_before"]
                and prior_cleanup["source_status_sha256_after"] == data["source_status_sha256_before"]
            )
            prior_cleanup["logs_preserved"] = require_logs(data).is_dir()
            prior_cleanup["completed"] = (
                recovery["completed"]
                and prior_cleanup["target_absent"]
                and prior_cleanup["worktree_list_absent"]
                and prior_cleanup["source_checkout_unchanged"]
                and prior_cleanup["logs_preserved"]
            )
            prior_cleanup["readback"] = (
                "recorded deregistered Windows residual removed by exact non-force PowerShell recovery"
                if prior_cleanup["completed"]
                else "recorded residual recovery incomplete; exact state preserved for owner review"
            )
            write_json(manifest, data)
            print(json.dumps(prior_cleanup, indent=2))
            if not prior_cleanup["completed"]:
                raise ContractError("recorded Windows residual recovery did not satisfy exact readback")
            return 0
    verify_target(data, target)
    check_cleanup_status(target)
    repo = Path(data["source_repo"])
    source_head_before = head_sha(repo)
    source_status_before = hashlib.sha256(status_bytes(repo)).hexdigest()
    if (
        source_head_before != data["source_head_before"]
        or source_status_before != data["source_status_sha256_before"]
    ):
        raise ContractError("source repository prestate changed; preserve target and source for owner review")
    if not worktree_is_registered(repo, target):
        raise ContractError("exact target is not registered as a Git worktree; preserve for owner review")
    require_logs(data)
    # Git refuses dirty/locked linked worktrees without --force. Never add --force.
    removal_error = None
    try:
        git(repo, "worktree", "remove", str(target))
    except ContractError as exc:
        removal_error = str(exc)

    target_present = target.exists() or target.is_symlink()
    target_registered = worktree_is_registered(repo, target)
    source_head_after = head_sha(repo)
    source_status_after = hashlib.sha256(status_bytes(repo)).hexdigest()
    source_unchanged = (
        source_head_after == data["source_head_before"]
        and source_status_after == data["source_status_sha256_before"]
    )
    residual_recovery = {"attempted": False, "completed": False, "force_used": False}
    completed = (
        removal_error is None
        and not target_present
        and not target_registered
        and source_unchanged
        and require_logs(data).is_dir()
    )
    data["cleanup"] = {
        "completed_utc": utc_now(),
        "completed": completed,
        "target": str(target),
        "target_present": target_present,
        "target_absent": not target_present,
        "target_registered_before": True,
        "target_registered_after": target_registered,
        "worktree_list_absent": not target_registered,
        "source_head_before": data["source_head_before"],
        "source_head_after": source_head_after,
        "source_status_sha256_before": data["source_status_sha256_before"],
        "source_status_sha256_after": source_status_after,
        "source_checkout_unchanged": source_unchanged,
        "logs_preserved": Path(data["logs_dir"]).exists(),
        "force_used": False,
        "git_remove_error": removal_error,
        "residual_recovery": residual_recovery,
        "readback": (
            "exact target absent and absent from NUL-delimited git worktree list"
            if completed else "cleanup incomplete; exact state recorded and any residual preserved for owner review"
        ),
    }
    write_json(manifest, data)
    print(json.dumps(data["cleanup"], indent=2))
    if removal_error is not None:
        raise ContractError("Git worktree removal failed; residual preserved for owner review: " + removal_error)
    if target_present:
        raise ContractError("Git reported success but the exact target still exists")
    if target_registered:
        raise ContractError("Git worktree readback still lists the exact removed target")
    if not source_unchanged:
        raise ContractError("source checkout changed during cleanup; preserve remaining state")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="action", required=True)
    p = sub.add_parser("prepare", help="Create a new detached worktree at an exact source pin")
    p.add_argument("--repo", required=True, help="Existing local Git checkout containing the pinned commit")
    p.add_argument("--pin", required=True, help="Full 40-character commit SHA")
    p.add_argument("--run-id", required=True, help="Unique safe identifier; determines exact contained target")
    p.add_argument("--app", required=True, help="App name for the manifest")
    p.set_defaults(func=cmd_prepare)
    s = sub.add_parser("status", help="Read exact target pin and cleanliness")
    s.add_argument("--run-id", required=True)
    s.set_defaults(func=cmd_status)
    c = sub.add_parser("cleanup", help="Remove exact clean owned worktree; never force")
    c.add_argument("--run-id", required=True)
    c.set_defaults(func=cmd_cleanup)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    try:
        args = build_parser().parse_args(argv)
        return args.func(args)
    except ContractError as exc:
        print(f"REFUSED: {exc}", file=sys.stderr)
        return 2
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
