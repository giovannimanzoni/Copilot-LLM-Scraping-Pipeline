import faulthandler
import logging
import os
import random
import shutil
import threading
import time
from collections import Counter
from pathlib import Path

from tqdm import tqdm

from worker.collectors.github import collect_github
# datasets / merge / stack are imported lazily inside the phase functions so that
# pyarrow C++ signal handlers are NOT installed at startup.  If they were installed
# at module-load time, a CTRL+C during the coordinator-unreachable retry loop would
# hit the C++ handler first (before Python) and segfault instead of exiting cleanly.
from worker.config import DATA_DIR1, NODE_NAME, THREADS_PHASE1, THREADS_PHASE2, log, node_paths
from worker.coordinator import (
    coord_get,
    coord_post,
    fetch_stack_languages,
    get_fleet_status,
    register_worker,
    send_heartbeat,
    wait_for_phase,
    wait_for_start,
)
from worker.checkpoint import ckpt_exists, load_ckpt
from worker.filtering import dedup
from worker.fim import to_fim


# Only one node at a time may format and save its dataset.
# Dataset.from_generator + save_to_disk holds the full Arrow representation in
# RAM while writing; running multiple saves in parallel multiplies peak memory
# by the number of concurrent threads and causes OOM on memory-limited machines.
_phase1_save_sem = threading.Semaphore(1)
_phase2_save_sem = threading.Semaphore(1)


def _run_phase1(node_id: int, node_name: str) -> None:
    """Phase 1: GitHub collection and dataset save for one node."""
    from datasets import Dataset  # noqa: PLC0415  (deferred to avoid pyarrow C++ init at startup)
    from worker.collectors.merge import save_and_validate  # noqa: PLC0415

    thread_log = logging.getLogger(f"node{node_id}")
    try:
        checkpoints_dir, _, phase1_output, _ = node_paths(node_id)
        checkpoints_dir.mkdir(exist_ok=True)

        random.seed(42 + node_id)
        thread_log.info(f"Node {node_id} ({node_name}) phase 1 started")

        collect_github(node_id, checkpoints_dir)

        github_ckpt = f"github_node{node_id}"
        github_samples: list[dict] = load_ckpt(github_ckpt, checkpoints_dir) if ckpt_exists(github_ckpt, checkpoints_dir) else []
        thread_log.info(f"Loaded {len(github_samples):,} github samples from checkpoint")
        github_samples = dedup(github_samples)
        thread_log.info(f"Phase1 (github) after dedup: {len(github_samples):,}")
        counts = Counter(s["lang"] for s in github_samples)
        for lang, count in counts.most_common():
            thread_log.info(f"  {lang:15s}: {count:,}")

        # Serialize the heavy format+save step: only one node holds RAM for
        # Arrow conversion at a time.  Other threads wait here (holding only
        # their loaded sample list) until the current saver finishes.
        with _phase1_save_sem:
            thread_log.info(f"Saving phase1 in {phase1_output}...")

            def _gen1():
                for s in tqdm(github_samples, desc=f"node{node_id} format phase1"):  # noqa: F821
                    yield {"text": to_fim(s["content"]), "lang": s["lang"], "source": s["source"]}

            ds1 = Dataset.from_generator(_gen1)
            del github_samples
            ds1 = ds1.shuffle(seed=42 + node_id)
            save_and_validate(ds1, phase1_output, f"phase1-node{node_id}")
            n_saved = len(ds1)
        thread_log.info(f"✅ Node {node_id} phase1 done — {n_saved:,} samples")
    except Exception:
        thread_log.exception(f"Node {node_id} phase 1 crashed unexpectedly")
        # Remove any incomplete output dir so merge doesn't see a partial shard.
        # Checkpoint files are untouched — a restart can re-save from them.
        output_path = Path(phase1_output)
        if output_path.exists() and not (output_path / "dataset_info.json").exists():
            shutil.rmtree(output_path, ignore_errors=True)
            thread_log.warning(f"Removed incomplete phase1 output dir after crash: {phase1_output}")


def _run_phase2(node_id: int, node_name: str, stack_languages: frozenset[str]) -> None:
    """Phase 2: Stack (HuggingFace) collection and dataset save for one node."""
    from datasets import Dataset  # noqa: PLC0415  (deferred to avoid pyarrow C++ init at startup)
    from worker.collectors.merge import save_and_validate  # noqa: PLC0415
    from worker.collectors.stack import collect_the_stack  # noqa: PLC0415

    thread_log = logging.getLogger(f"node{node_id}")
    try:
        checkpoints_dir, cache_dir, _, phase2_output = node_paths(node_id)
        checkpoints_dir.mkdir(exist_ok=True)
        Path(cache_dir).mkdir(exist_ok=True)

        random.seed(42 + node_id)
        thread_log.info(f"Node {node_id} ({node_name}) phase 2 started")

        collect_the_stack(node_id, cache_dir, checkpoints_dir, stack_languages)

        stack_samples: list[dict] = []
        for ckpt_file in sorted(checkpoints_dir.glob("stack_*.jsonl")):
            name = ckpt_file.stem
            if name.endswith("_partial"):
                continue
            stack_samples.extend(load_ckpt(name, checkpoints_dir))
        thread_log.info(f"Loaded {len(stack_samples):,} stack samples from checkpoints")
        stack_samples = dedup(stack_samples)
        thread_log.info(f"Phase2 (stack) after dedup: {len(stack_samples):,}")
        counts = Counter(s["lang"] for s in stack_samples)
        for lang, count in counts.most_common():
            thread_log.info(f"  {lang:15s}: {count:,}")
        # Serialize the heavy format+save step: only one node holds RAM for
        # Arrow conversion at a time.  Other threads wait here (holding only
        # their loaded sample list) until the current saver finishes.
        with _phase2_save_sem:
            thread_log.info(f"Saving phase2 in {phase2_output}...")

            def _gen2():
                for s in tqdm(stack_samples, desc=f"node{node_id} format phase2"):  # noqa: F821
                    yield {"text": to_fim(s["content"]), "lang": s["lang"], "source": s["source"]}

            ds2 = Dataset.from_generator(_gen2)
            del stack_samples
            ds2 = ds2.shuffle(seed=42 + node_id)
            save_and_validate(ds2, phase2_output, f"phase2-node{node_id}")
            n_saved2 = len(ds2)
        thread_log.info(f"✅ Node {node_id} phase2 done — {n_saved2:,} samples")
    except Exception:
        thread_log.exception(f"Node {node_id} phase 2 crashed unexpectedly")
        # Remove any incomplete output dir so merge doesn't see a partial shard.
        output_path = Path(phase2_output)
        if output_path.exists() and not (output_path / "dataset_info.json").exists():
            shutil.rmtree(output_path, ignore_errors=True)
            thread_log.warning(f"Removed incomplete phase2 output dir after crash: {phase2_output}")


def _join_threads(threads: list[threading.Thread]) -> None:
    """Join a list of threads, polling with a short timeout to keep signals responsive."""
    for t in threads:
        t.start()
    for t in threads:
        while t.is_alive():
            t.join(timeout=1.0)


def multi_worker_main(n_phase1: int | None = None) -> None:
    """Start worker threads on this machine, running phases sequentially.

    Responsibilities of the main process (runs once):
    - Determine per-phase thread counts (CLI arg > env var > os.cpu_count() for phase1;
      THREADS_PHASE2 env var > 1 for phase2)
    - Enable process-wide crash handler
    - Register the machine with max(n1, n2) node_ids
    - Wait for the fleet start signal, then run phases in sequence:
        Phase 1 (GitHub)  — n1 threads
        Phase 2 (Stack)   — n2 threads (always from THREADS_PHASE2, defaults to 1)
        Phase 3 (Merge)   — 1 thread (single-threaded by design)
    """
    cpu = os.cpu_count() or 1
    n1 = n_phase1 if n_phase1 is not None else (THREADS_PHASE1 if THREADS_PHASE1 is not None else cpu)
    n2 = THREADS_PHASE2 if THREADS_PHASE2 is not None else 1
    n_total = max(n1, n2)

    log.info(
        f"Starting on machine '{NODE_NAME}': "
        f"phase1={n1} thread(s), phase2={n2} thread(s), phase3=1 thread"
    )

    # Enable crash reporting for all threads before any thread starts.
    crash_log = open(DATA_DIR1 / f"crash_{NODE_NAME}.log", "w")
    faulthandler.enable(file=crash_log, all_threads=True)

    # All worker threads are daemon threads (see threads1/threads2 below).
    # Daemon threads don't block Python shutdown, so when Ctrl+C raises
    # KeyboardInterrupt in the main thread the process exits and all daemon
    # threads are killed immediately — no hanging, no need for os._exit().
    #
    # Why NOT os._exit(0):  pyarrow/datasets lazily installs C-level sigaction
    # handlers when Dataset.from_generator() / load_dataset() first runs.  Those
    # C-level registrations override signal.signal(), so our os._exit handler is
    # never called.  Instead the C++ cleanup code runs on SIGINT and segfaults
    # ("Errore di segmentazione" / Segmentation fault).

    start_id = register_worker(NODE_NAME, n_total, n1, n2)
    all_ids = list(range(start_id, start_id + n_total))
    log.info(f"  node_ids assigned: {all_ids}")
    stack_languages = fetch_stack_languages()
    log.info(f"  [config] stack_languages={sorted(stack_languages)}")
    fleet = wait_for_start(all_ids)

    github_enabled  = fleet.get("github_enabled", True)
    stack_enabled   = fleet.get("stack_enabled", True)
    merge_enabled   = fleet.get("merge_enabled", True)
    merge_shared_fs = fleet.get("merge_shared_fs", False)
    fleet_phase     = int(fleet.get("phase", 1))
    log.info(
        f"  [fleet] started — github_enabled={github_enabled}, stack_enabled={stack_enabled}, "
        f"merge_enabled={merge_enabled}, merge_shared_fs={merge_shared_fs}, phase={fleet_phase}"
    )

    # Phase 1: GitHub collection — n1 threads
    if github_enabled:
        if fleet_phase > 1:
            log.info(f"[worker] phase 1 skipped — coordinator already at phase {fleet_phase}")
        else:
            threads1 = [
                threading.Thread(
                    target=_run_phase1,
                    args=(node_id, NODE_NAME),
                    name=f"worker-node{node_id}-phase1",
                    daemon=True,
                )
                for node_id in all_ids[:n1]
            ]
            _join_threads(threads1)
            log.info("[worker] phase 1 complete")

    # Phase 2: Stack collection — n2 threads
    if stack_enabled:
        if fleet_phase > 2:
            log.info(f"[worker] phase 2 skipped — coordinator already at phase {fleet_phase}")
        else:
            wait_for_phase(2, all_ids[0])
            threads2 = [
                threading.Thread(
                    target=_run_phase2,
                    args=(node_id, NODE_NAME, stack_languages),
                    name=f"worker-node{node_id}-phase2",
                    daemon=True,
                )
                for node_id in all_ids[:n2]
            ]
            _join_threads(threads2)
            log.info("[worker] phase 2 complete")

    if not github_enabled and not stack_enabled:
        log.info("  [skip] collection disabled — skipping dataset save")

    # Wait for the operator to fire phase 3 before signalling merge-readiness.
    # Workers idle here — polling every 20 s and sending heartbeats for every
    # node — so they remain visible in the dashboard between phase 2 and phase 3.
    # merge_ready is posted only once phase 3 is actually running, because the
    # coordinator waits for all merge_ready signals before handing out merge tasks.
    log.info("  [merge] collection done — idling until phase 3 is fired (polling every 20 s)...")
    while True:
        status = get_fleet_status()
        current_phase = int(status.get("phase", 1))
        state = status.get("state", "running")
        if state == "running" and current_phase >= 3:
            break
        for nid in all_ids:
            send_heartbeat(nid, "idle")
        log.info(f"  [idle] phase 3 not started yet (phase={current_phase}, state={state}) — checking again in 20 s")
        time.sleep(20)

    log.info("  [merge] phase 3 detected — signalling merge-ready for all nodes")
    for node_id in all_ids:
        coord_post("/node/merge_ready", {"node_id": node_id})

    # Phase 3: Merge — single thread
    from worker.collectors.merge import run_merge, run_post_merge  # noqa: PLC0415  (deferred)
    if merge_enabled:
        merge_resp = coord_get(f"/merge/next/{all_ids[0]}")
        has_task = bool(merge_resp.get("task"))

        if has_task:
            log.info("  [merge] assigned — starting local dataset merge")
        elif not merge_shared_fs:
            # No merge task (e.g. merge_target_node is set to another machine), but in
            # non-shared-FS mode this machine must still merge its local data and upload
            # a partial so the Final Merger can integrate it.  Skip only for shared-FS
            # where one machine accesses all data directly.
            log.info("  [merge] no task assigned — running local merge to upload partial")
        else:
            log.info("  [merge] another worker is handling the merge (shared FS) — done")

        if has_task or not merge_shared_fs:
            n_samples = run_merge(all_ids[0])
            coord_post("/merge/done", {"node_id": all_ids[0], "samples": n_samples})
            log.info(f"  [merge] local merge complete — {n_samples:,} samples")
            # run_post_merge never returns — it idles indefinitely after signalling done
            run_post_merge(NODE_NAME, merge_shared_fs, all_ids[0])
    else:
        log.info("  [merge] merge disabled — idling")

    log.info("[worker] all phases done — idling")
    while True:
        for nid in all_ids:
            send_heartbeat(nid, "idle")
        time.sleep(60)
