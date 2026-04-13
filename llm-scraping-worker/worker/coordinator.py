import contextlib
import os
import shutil
import threading
import time
from collections.abc import Generator
from pathlib import Path
from typing import BinaryIO

import requests
import sentry_sdk

from worker.config import COORDINATOR_URL, DATA_DIR3, NODE_HASH, NODE_NAME, TMPFS_DIR, log


# ─────────────────────────────────────────
# HTTP CLIENT
# ─────────────────────────────────────────

def _coord_request(method: str, path: str, retries: int = 3, **kwargs) -> dict:
    """Send an HTTP request to the coordinator.

    Connection errors and 5xx responses (coordinator down or temporarily broken)
    are retried indefinitely with a 60 s back-off so a temporary coordinator
    restart or internal error does not crash the worker.
    4xx responses and other errors are retried up to *retries* times with
    exponential back-off, then re-raised.
    """
    url = f"{COORDINATOR_URL}{path}"
    attempt = 0
    while True:
        try:
            r = requests.request(method, url, timeout=10, **kwargs)
            if r.status_code >= 500:
                log.warning(f"  [coord] coordinator returned {r.status_code} at {url} — retrying in 60s")
                time.sleep(60)
                attempt = 0  # server errors don't count against the transient-error budget
                continue
            r.raise_for_status()
            return r.json()
        except (requests.exceptions.ConnectionError, requests.exceptions.Timeout) as e:
            log.warning(f"  [coord] coordinator unreachable at {url} — retrying in 60s ({e})")
            time.sleep(60)
            attempt = 0  # reset transient-error counter; connection/timeout errors don't count
        except Exception as e:
            attempt += 1
            if attempt >= retries:
                sentry_sdk.capture_exception(e)
                raise
            time.sleep(2 ** (attempt - 1))


def coord_get(path: str, retries: int = 3) -> dict:
    return _coord_request("GET", path, retries=retries)


def coord_post(path: str, data: dict, retries: int = 3) -> dict:
    return _coord_request("POST", path, retries=retries, json=data)


def coord_post_nowait(path: str, data: dict) -> None:
    """Fire-and-forget POST to the coordinator.

    Uses a 3 s timeout and no retries. Designed for high-frequency progress
    updates (e.g. save_progress) where missing one update is acceptable and
    blocking the caller for up to 33 s on transient errors is not.
    Silently drops the request if the coordinator is busy or unreachable.
    """
    try:
        requests.post(f"{COORDINATOR_URL}{path}", json=data, timeout=3)
    except Exception:
        pass


# ─────────────────────────────────────────
# WORKER REGISTRATION & HEARTBEAT
# ─────────────────────────────────────────

def register_worker(node_name: str, n_threads: int, n_phase1: int, n_phase2: int) -> int:
    """Register this machine with the coordinator.

    The coordinator atomically allocates *n_threads* consecutive globally-unique
    node_ids and returns the first one (start_node_id). The caller derives all
    thread node_ids as range(start_node_id, start_node_id + n_threads).

    On crash recovery (same NODE_NAME + NODE_HASH already registered), the
    coordinator returns the previously assigned start_node_id unchanged.

    Exits the process immediately on 400 (invalid params) or 409 (name taken).
    """
    try:
        r = requests.post(
            f"{COORDINATOR_URL}/worker/register",
            json={
                "node_name": node_name,
                "node_hash": NODE_HASH,
                "n_threads": n_threads,
                "n_threads_phase1": n_phase1,
                "n_threads_phase2": n_phase2,
            },
            timeout=10,
        )
        if r.status_code == 400:
            print(f"ERROR: Registration rejected by coordinator (invalid parameters): {r.text}", flush=True)
            os._exit(1)
        if r.status_code == 409:
            reason = r.json().get("reason", "unknown")
            print(f"ERROR: NODE_NAME '{node_name}' is already taken by another machine (reason={reason}) — exiting", flush=True)
            os._exit(1)
        r.raise_for_status()
        start_node_id: int = r.json()["start_node_id"]
        all_ids = list(range(start_node_id, start_node_id + n_threads))
        log.info(f"Machine '{node_name}' registered with {n_threads} thread(s) (node_ids: {all_ids}, phase1={n_phase1}, phase2={n_phase2})")
        return start_node_id
    except Exception as e:
        log.warning(f"Machine registration failed: {e}")
        return 1  # fallback — should not happen in practice


def send_heartbeat(node_id: int, status: str = "working") -> None:
    try:
        coord_post("/heartbeat", {"node_id": node_id, "worker_status": status})
    except Exception as e:
        log.warning(f"Heartbeat fallito: {e}")


@contextlib.contextmanager
def heartbeat_ctx(node_id: int, status: str = "merging", interval: int = 60) -> Generator[None, None, None]:
    """Send heartbeats in the background every *interval* seconds.

    Use around long CPU/disk operations (save_to_disk, tar+zstd, concatenate_datasets)
    that cannot call send_heartbeat directly, so the watchdog does not flag this worker
    as unresponsive.  The background thread is a daemon so it is automatically cleaned
    up if the process exits before the context manager exits.
    """
    stop = threading.Event()

    def _loop() -> None:
        while not stop.wait(timeout=float(interval)):
            send_heartbeat(node_id, status)

    t = threading.Thread(target=_loop, daemon=True, name="heartbeat-bg")
    t.start()
    try:
        yield
    finally:
        stop.set()
        t.join(timeout=5)


# ─────────────────────────────────────────
# FLEET STATE
# ─────────────────────────────────────────

def fetch_stack_languages() -> frozenset[str]:
    """Fetch the list of stack languages to collect from the coordinator."""
    data = coord_get("/config")
    return frozenset(data.get("stack_languages", ["typescript"]))


def get_fleet_status() -> dict:
    """Returns {state, phase} from the coordinator (fail-open defaults on error)."""
    try:
        return coord_get("/fleet/state")
    except Exception:
        return {"state": "running", "phase": 1}  # fail-open


def is_fleet_running() -> bool:
    return get_fleet_status().get("state", "running") == "running"


def wait_if_stopped(node_id: int) -> None:
    """Block until the fleet state is 'running'. Polls every 5 seconds."""
    if is_fleet_running():
        return
    log.info("  [fleet] stopped — waiting for start signal...")
    while not is_fleet_running():
        send_heartbeat(node_id, "idle")
        time.sleep(5)
    log.info("  [fleet] started — resuming")


def wait_for_phase(phase: int, node_id: int, poll_interval: int = 5) -> None:
    """Block until fleet state is 'running' AND fleet phase == phase.

    Also returns immediately if the fleet has already advanced past the requested phase,
    so callers stuck in a loop don't block forever when a phase transition is missed.

    Args:
        poll_interval: seconds between coordinator polls (default 5).
    """
    first = True
    while True:
        status = get_fleet_status()
        current_phase = int(status.get("phase", phase))
        state = status.get("state", "running")
        if state == "running" and current_phase == phase:
            return
        if current_phase > phase:
            return
        if first:
            log.info(f"  [node{node_id}] Phase {phase}: waiting to start")
            first = False
        log.info(f"  [node{node_id}] waiting for phase {phase} (current: phase={current_phase}, state={state})...")
        send_heartbeat(node_id, "idle")
        time.sleep(poll_interval)


def wait_for_start(node_ids: list[int]) -> dict:
    """Block until the operator starts the fleet (phase > 0 and state == running).

    Returns the fleet status the moment the fleet transitions to running.
    Sends an idle heartbeat for every node_id so all threads appear as IDLE in the
    dashboard while waiting. Shows a single 'waiting for start' log line on entry.
    """
    first = True
    while True:
        status = get_fleet_status()
        if int(status.get("phase", 0)) > 0 and status.get("state") == "running":
            return status
        if first:
            log.info("  [fleet] waiting for start signal from operator...")
            first = False
        for nid in node_ids:
            send_heartbeat(nid, "idle")
        time.sleep(5)


# ─────────────────────────────────────────
# POST-MERGE ORCHESTRATION HELPERS
# ─────────────────────────────────────────

def coord_get_node_names() -> list[str]:
    """Return all registered node_names from the coordinator."""
    return coord_get("/merge/node_names").get("node_names", [])


def coord_claim_final_merger() -> bool:
    """Atomically try to claim the Final Merger role. Returns True if claimed."""
    return coord_post("/merge/claim_final", {"node_name": NODE_NAME}).get("is_final_merger", False)


def coord_partials_status() -> list[str]:
    """Return the list of node_names that have already uploaded their partial zip."""
    return coord_get("/merge/partials_status").get("uploaded", [])


def coord_upload_zip(
    endpoint: str,
    zip_path: Path,
    *,
    progress_node_name: str = "",
    progress_stage: str = "",
) -> dict:
    """Upload a zip file to coordinator *endpoint* as raw octet-stream.

    Retries indefinitely on connection errors, timeouts, 408, and 5xx responses.
    Raises on other HTTP errors (4xx except 408).
    Uses no read timeout because uploads can be very large.

    If *progress_node_name* is set, a background thread reports upload progress
    to /merge/transfer_progress every ~5% via fire-and-forget POSTs.
    """
    url = f"{COORDINATOR_URL}{endpoint}"
    file_size = zip_path.stat().st_size

    while True:
        try:
            bytes_sent: list[int] = [0]
            done_event = threading.Event()

            class _ProgressReader:
                def __init__(self, fh: BinaryIO) -> None:
                    self._fh = fh

                def read(self, n: int = -1) -> bytes:
                    chunk = self._fh.read(n)
                    if chunk:
                        bytes_sent[0] += len(chunk)
                    return chunk

            def _report_progress() -> None:
                last_pct = -1
                coord_post_nowait("/merge/transfer_progress", {
                    "node_name": progress_node_name, "stage": progress_stage,
                    "bytes_done": 0, "bytes_total": file_size,
                })
                while not done_event.wait(timeout=3.0):
                    if file_size > 0:
                        pct = int(bytes_sent[0] * 100 / file_size)
                        if pct >= last_pct + 5:
                            last_pct = pct
                            coord_post_nowait("/merge/transfer_progress", {
                                "node_name": progress_node_name, "stage": progress_stage,
                                "bytes_done": bytes_sent[0], "bytes_total": file_size,
                            })
                # Send final 100% update once upload is complete
                coord_post_nowait("/merge/transfer_progress", {
                    "node_name": progress_node_name, "stage": progress_stage,
                    "bytes_done": file_size, "bytes_total": file_size,
                })

            if progress_node_name:
                t = threading.Thread(target=_report_progress, daemon=True, name="upload-progress")
                t.start()
            try:
                with open(zip_path, "rb") as fh:
                    data_src: BinaryIO = _ProgressReader(fh) if progress_node_name else fh  # type: ignore[assignment]
                    r = requests.post(
                        url,
                        data=data_src,
                        headers={
                            "Content-Type": "application/octet-stream",
                            "Content-Length": str(file_size),
                        },
                        timeout=(30, None),  # 30 s connect; no read timeout for large files
                    )
            finally:
                if progress_node_name:
                    done_event.set()
                    t.join(timeout=5)

            if r.status_code == 408 or r.status_code >= 500:
                log.warning(f"  [coord] upload got {r.status_code} at {url} — retrying in 30s")
                time.sleep(30)
                continue
            r.raise_for_status()
            return r.json()
        except (requests.exceptions.ConnectionError, requests.exceptions.Timeout) as e:
            log.warning(f"  [coord] coordinator unreachable at {url} — retrying in 30s ({e})")
            time.sleep(30)
        except Exception as e:
            sentry_sdk.capture_exception(e)
            raise


def coord_download_partial(node_name: str) -> Path:
    """Download another machine's partial zip from the coordinator.

    Saves to tmpfs if it fits, otherwise to DATA_DIR3.
    Reports download progress to /merge/transfer_progress every ~5%.
    Returns the local path of the downloaded zip.
    """
    url = f"{COORDINATOR_URL}/merge/download_partial/{node_name}"
    while True:
        try:
            r = requests.get(url, stream=True, timeout=(30, None))
            r.raise_for_status()
            content_length = int(r.headers.get("content-length", 0))
            # Prefer tmpfs for fast I/O; fall back to DATA_DIR3 if not enough space
            if TMPFS_DIR.exists() and shutil.disk_usage(TMPFS_DIR).free > content_length:
                dest = TMPFS_DIR / f"partial_{node_name}.tar.zst"
            else:
                dest = DATA_DIR3 / f"partial_{node_name}.tar.zst"
            # Report download start
            coord_post_nowait("/merge/transfer_progress", {
                "node_name": NODE_NAME, "stage": "downloading_partial",
                "bytes_done": 0, "bytes_total": content_length, "peer": node_name,
            })
            bytes_done = 0
            last_report_pct = -1
            with open(dest, "wb") as fh:
                for chunk in r.iter_content(chunk_size=1024 * 1024):
                    fh.write(chunk)
                    bytes_done += len(chunk)
                    if content_length > 0:
                        pct = int(bytes_done * 100 / content_length)
                        if pct >= last_report_pct + 5:
                            last_report_pct = pct
                            coord_post_nowait("/merge/transfer_progress", {
                                "node_name": NODE_NAME, "stage": "downloading_partial",
                                "bytes_done": bytes_done, "bytes_total": content_length,
                                "peer": node_name,
                            })
            log.info(f"  [merge] downloaded partial '{node_name}' → {dest} ({content_length:,} bytes)")
            return dest
        except requests.exceptions.ConnectionError as e:
            log.warning(f"  [coord] coordinator unreachable — retrying in 30s ({e})")
            time.sleep(30)
        except Exception as e:
            sentry_sdk.capture_exception(e)
            raise
