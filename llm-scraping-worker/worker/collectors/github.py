import datetime
import hashlib
import json
import os
import shutil
import subprocess
import time
from pathlib import Path

import sentry_sdk

from worker.checkpoint import append_ckpt, ckpt_exists, ckpt_path
from worker.config import CLONE_TIMEOUT, DATA_DIR1, GITHUB_TOKEN, TMPFS_DIR, log
from worker.coordinator import coord_get, coord_post, fetch_file_extensions, get_fleet_status, send_heartbeat, wait_for_phase
from worker.filtering import is_valid_code


def _device_path(path: Path) -> str:
    """Return the device path (e.g. /dev/sda1) that backs the given path."""
    try:
        result = subprocess.run(
            ["df", "--output=source", str(path)],
            capture_output=True, text=True, timeout=5,
        )
        lines = result.stdout.strip().splitlines()
        return lines[-1].strip() if len(lines) >= 2 else str(path)
    except Exception:
        return str(path)


def _is_no_space_error(stderr: str, path: Path) -> bool:
    """Detect 'no space left on device' regardless of system locale."""
    lower = stderr.lower()
    # English and Italian (locale-specific git messages)
    if "no space left on device" in lower or "spazio esaurito" in lower:
        return True
    # Locale-agnostic fallback: check actual free space on the filesystem
    try:
        return os.statvfs(path).f_bavail == 0
    except Exception:
        return False


def _log_clone_error(repo_full_name: str, reason: str) -> None:
    """Append a clone failure record to data/error.log."""
    ts = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    line = f"{ts} | repo={repo_full_name} | error={reason}\n"
    try:
        with open(DATA_DIR1 / "error.log", "a", encoding="utf-8") as f:
            f.write(line)
    except Exception as exc:
        log.warning(f"  [error.log] failed to write: {exc}")


def clone_and_extract(repo_full_name: str, file_extensions: list[str]) -> list[dict] | str:
    """Returns list of samples on success (possibly empty), or an error reason string on failure."""
    log.info(f"  [clone] Cloning {repo_full_name}...")
    if not TMPFS_DIR.is_mount():
        log.warning(f"  [clone] WARNING: {TMPFS_DIR} is NOT a mount point — cloning to disk!")

    safe_name = repo_full_name.replace("/", "_")
    clone_dir: Path = TMPFS_DIR / safe_name
    if clone_dir.exists():
        shutil.rmtree(clone_dir)

    clone_url = f"https://x-access-token:{GITHUB_TOKEN}@github.com/{repo_full_name}.git"
    clone_env = {**os.environ, "GIT_TERMINAL_PROMPT": "0"}

    with sentry_sdk.start_span(op="git.clone", description=repo_full_name):
        tried_data_dir = False
        try:
            while True:
                result = subprocess.run(
                    ["git", "clone", "--depth=1", "--quiet", clone_url, str(clone_dir)],
                    capture_output=True, text=True, timeout=CLONE_TIMEOUT,
                    env=clone_env,
                )
                if result.returncode != 0:
                    if _is_no_space_error(result.stderr, clone_dir.parent):
                        device = _device_path(clone_dir.parent)
                        if clone_dir.exists():
                            shutil.rmtree(clone_dir)
                        if not tried_data_dir:
                            log.warning(
                                f"  [no space] {repo_full_name}: {device} full — retrying in data dir"
                            )
                            clone_dir = DATA_DIR1 / "tmp_clone" / safe_name
                            clone_dir.parent.mkdir(parents=True, exist_ok=True)
                            if clone_dir.exists():
                                shutil.rmtree(clone_dir)
                            tried_data_dir = True
                            continue
                        data_device = _device_path(DATA_DIR1)
                        reason = f"clone failed: no space left on device (tmpfs={_device_path(TMPFS_DIR)}, data={data_device} both full)"
                        log.warning(f"  [no space] {repo_full_name}: both {_device_path(TMPFS_DIR)} and {data_device} are full")
                        _log_clone_error(repo_full_name, reason)
                        return reason
                    stderr_lower = result.stderr.lower()
                    if any(kw in stderr_lower for kw in ("authentication failed", "terminal prompts disabled", "could not read username", "invalid credentials")):
                        reason = "skipped: private repo (authentication failed)"
                        log.warning(f"  [auth fail] {repo_full_name}: private repo, credentials rejected")
                        _log_clone_error(repo_full_name, reason)
                        return reason
                    if "not found" in stderr_lower or "does not exist" in stderr_lower:
                        reason = "skipped: repo not found (deleted or renamed)"
                        log.warning(f"  [not found] {repo_full_name}: repo no longer exists, skipping")
                        _log_clone_error(repo_full_name, reason)
                        return reason
                    reason = f"clone failed (exit {result.returncode}): {result.stderr[:200].strip()}"
                    log.warning(f"  [clone fail] {repo_full_name}: {result.stderr[:200].strip()}")
                    _log_clone_error(repo_full_name, reason)
                    return reason
                break

            skip_dirs = {"node_modules", "dist", ".git", "build", "coverage", "vendor"}
            samples = []

            for path in clone_dir.rglob("*"):
                if any(skip in path.parts for skip in skip_dirs):
                    continue
                if ".min." in path.name:
                    continue
                if not any(path.name.endswith(ext) for ext in file_extensions):
                    continue
                try:
                    if path.stat().st_size > 100_000:
                        continue
                    content = path.read_text(encoding="utf-8", errors="ignore")
                    if is_valid_code(content, "typescript"):
                        samples.append({
                            "content": content,
                            "source": f"github:{repo_full_name}",
                            "lang": "typescript",
                        })
                except Exception:
                    pass

            return samples

        except subprocess.TimeoutExpired:
            reason = f"clone timed out after {CLONE_TIMEOUT}s"  # CLONE_TIMEOUT is always set when this fires
            log.warning(f"  [timeout] {repo_full_name}: {reason}")
            _log_clone_error(repo_full_name, reason)
            return reason
        except Exception as e:
            sentry_sdk.capture_exception(e)
            reason = f"exception: {e}"
            log.error(f"  [ERROR] clone {repo_full_name}: {e}")
            _log_clone_error(repo_full_name, reason)
            return reason
        finally:
            if clone_dir.exists():
                shutil.rmtree(clone_dir)


def collect_github(node_id: int, checkpoints_dir: Path) -> None:
    log.info(f"[Node {node_id}] === GITHUB ===")
    ckpt_name = f"github_node{node_id}"

    # Fast-path on restart: if the coordinator has already advanced past phase 1
    # and a checkpoint exists, there is nothing left to collect.  Entering the
    # repo loop here would waste several minutes polling a queue that is already
    # closed, and delay the dataset-save step unnecessarily.
    fleet_status = get_fleet_status()
    if int(fleet_status.get("phase", 1)) > 1 and ckpt_exists(ckpt_name, checkpoints_dir):
        log.info(f"  [node{node_id}] Coordinator already past phase 1 — skipping repo collection (checkpoint present)")
        return

    file_extensions = fetch_file_extensions()
    log.info(f"  [node{node_id}] File extensions to collect: {file_extensions}")

    # phase 1: cloning
    log.info(f"  [node{node_id}] Phase 1: cloning repos...")
    # Build seen_hashes by streaming the checkpoint line-by-line — avoids loading
    # all sample content into RAM just to reconstruct the dedup set on resume.
    seen_hashes: set[str] = set()
    if ckpt_exists(ckpt_name, checkpoints_dir):
        with open(ckpt_path(ckpt_name, checkpoints_dir), encoding="utf-8") as _f:
            for _line in _f:
                _line = _line.strip()
                if _line:
                    _content = json.loads(_line).get("content", "")
                    seen_hashes.add(hashlib.md5(_content.encode()).hexdigest())

    with sentry_sdk.start_transaction(op="task", name=f"github.clone.node{node_id}"):
        while True:
            wait_for_phase(1, node_id)
            resp = coord_get(f"/repos/next/{node_id}")
            repo = resp.get("repo")

            if not repo:
                fleet_status = get_fleet_status()
                fleet_phase = int(fleet_status.get("phase", 1))
                fleet_state = fleet_status.get("state", "running")
                if fleet_phase > 1 and fleet_state == "running":
                    log.info(f"  [node{node_id}] Coordinator already at phase {fleet_phase} — exiting repo loop.")
                    break
                if fleet_phase > 1 and fleet_state == "stopped":
                    log.info(f"  [node{node_id}] Phase 2 done, coordinator stopped at phase {fleet_phase} — waiting...")
                    send_heartbeat(node_id, "idle")
                    time.sleep(15)
                    continue
                log.info(f"  [node{node_id}] No repo, waiting 20s...")
                send_heartbeat(node_id, "idle")
                time.sleep(20)
                continue

            send_heartbeat(node_id)
            result = clone_and_extract(repo, file_extensions)

            if isinstance(result, str):
                log.warning(f"  [fail] {repo} — {result}")
                coord_post("/repos/fail", {
                    "repo": repo,
                    "node_id": node_id,
                    "reason": result,
                })
                continue

            new_samples = result

            unique_new = []
            for s in new_samples:
                h = hashlib.md5(s["content"].encode()).hexdigest()
                if h not in seen_hashes:
                    unique_new.append(s)
                    seen_hashes.add(h)

            if unique_new:
                append_ckpt(ckpt_name, unique_new, checkpoints_dir)

            coord_post("/repos/done", {
                "repo": repo,
                "node_id": node_id,
                "samples": len(unique_new),
            })

