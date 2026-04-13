import os
import shutil
import subprocess
import threading
import time
from pathlib import Path

from datasets import Dataset, concatenate_datasets, load_from_disk

from worker.config import DATA_DIR1, DATA_DIR2, DATA_DIR3, NODE_NAME, log
from worker.coordinator import (
    coord_claim_final_merger,
    coord_download_partial,
    coord_get_node_names,
    coord_partials_status,
    coord_post,
    coord_post_nowait,
    coord_upload_zip,
    heartbeat_ctx,
    send_heartbeat,
)

FINAL_MERGED_OUTPUT = str(DATA_DIR3 / "final_dataset")
_MAX_SAVE_RETRIES = 3


def _validate_dataset(path: str, expected_n: int) -> tuple[bool, str]:
    """Return (True, '') if the dataset at *path* is loadable with the expected sample count."""
    p = Path(path)
    if not (p / "dataset_info.json").exists():
        return False, "dataset_info.json missing"
    try:
        ds = load_from_disk(path)
        if len(ds) != expected_n:
            return False, f"sample count: expected {expected_n:,}, got {len(ds):,}"
    except Exception as exc:
        return False, f"load_from_disk raised: {exc}"
    return True, ""


def save_and_validate(
    dataset: Dataset,
    output_dir: str,
    label: str,
    max_retries: int = _MAX_SAVE_RETRIES,
    **kwargs,
) -> None:
    """Save a dataset to disk, validate it, and retry on failure.

    Deletes any partial output before each attempt so every retry starts clean.
    Raises RuntimeError after *max_retries* consecutive failures.
    """
    output_path = Path(output_dir)
    expected = len(dataset)

    for attempt in range(1, max_retries + 1):
        if output_path.exists():
            shutil.rmtree(output_path)

        log.info(f"[merge] {label}: save attempt {attempt}/{max_retries} ({expected:,} samples) → {output_dir}")
        try:
            dataset.save_to_disk(output_dir, **kwargs)
        except Exception as exc:
            log.warning(f"[merge] {label}: save_to_disk raised on attempt {attempt}: {exc}")
            if attempt == max_retries:
                raise
            continue

        valid, reason = _validate_dataset(output_dir, expected)
        if valid:
            log.info(f"[merge] {label}: dataset validated OK — {expected:,} samples")
            return
        log.warning(f"[merge] {label}: broken dataset on attempt {attempt}: {reason} — retrying")
        if attempt == max_retries:
            raise RuntimeError(f"[merge] {label}: dataset broken after {max_retries} attempts: {reason}")


def _monitor_save_progress(
    output_dir: str,
    node_id: int,
    num_shards: int,
    done_event: threading.Event,
) -> None:
    """Background thread: reports save_to_disk progress by counting shard files.

    Tracks completed shards (all files except the last) plus an estimate of the
    in-progress shard's completion by comparing its size to the first completed shard.
    Supports both .arrow (datasets >= 2.x default) and .parquet shard files.
    Reports to /merge/save_progress at every 0.1% change using a fire-and-forget
    POST (short timeout, no retries) so the monitor is never blocked by HTTP latency.
    """
    output_path = Path(output_dir)
    last_pct = -2.0
    shard_size_est: float | None = None

    # Wait for output directory to be created
    while not done_event.is_set() and not output_path.exists():
        time.sleep(0.05)

    while not done_event.is_set():
        try:
            parquet_files = sorted(output_path.glob("data-*.arrow")) or sorted(output_path.glob("data-*.parquet"))
            n_files = len(parquet_files)
            if n_files == 0:
                time.sleep(0.05)
                continue

            # Learn expected shard size from the first completed shard
            # (detectable when a second file exists — first one is fully written)
            if n_files >= 2 and shard_size_est is None:
                shard_size_est = float(parquet_files[0].stat().st_size)
                if shard_size_est <= 0:
                    shard_size_est = None

            # Estimate fractional progress of the in-progress shard
            if shard_size_est and n_files >= 2:
                completed = n_files - 1
                in_progress_bytes = float(parquet_files[-1].stat().st_size)
                in_progress_frac = min(in_progress_bytes / shard_size_est, 0.99)
                progress_units = completed + in_progress_frac
            else:
                progress_units = float(n_files)

            pct = min(progress_units / num_shards * 100, 99.9)

            if pct - last_pct >= 0.1:
                last_pct = pct
                coord_post_nowait("/merge/save_progress", {"node_id": node_id, "pct": round(pct, 1)})
        except Exception as exc:
            log.debug(f"[merge] save monitor error: {exc}")
        time.sleep(0.05)


def run_merge(node_id: int) -> int:
    """Merge all per-node datasets into a single final dataset.

    Scans DATA_DIR1/DATA_DIR2 for dataset_node* directories, concatenates them,
    shuffles, and saves to data/final_dataset/.

    Reports per-shard progress to the coordinator after each shard is loaded.
    Returns the total number of samples in the merged dataset.
    """
    all_candidates = sorted(DATA_DIR1.glob("dataset_node*")) + sorted(DATA_DIR2.glob("dataset_node*"))
    shards = [s for s in all_candidates if (s / "dataset_info.json").exists()]
    stale = [s for s in all_candidates if s not in shards]
    if stale:
        log.warning(
            f"[merge] removing {len(stale)} stale/incomplete shard dir(s) (no dataset_info.json): "
            f"{[s.name for s in stale]}"
        )
        for s in stale:
            shutil.rmtree(s, ignore_errors=True)
    if not shards:
        log.warning("[merge] no per-node datasets found — nothing to merge")
        return 0

    shards_total = len(shards)
    log.info(f"[merge] merging {shards_total} shard(s): {[s.name for s in shards]}")

    datasets: list[Dataset] = []
    for i, shard in enumerate(shards, 1):
        log.info(f"[merge] loading shard {i}/{shards_total}: {shard.name} ...")
        ds = load_from_disk(str(shard))
        datasets.append(ds)
        log.info(f"[merge]   shard {i}/{shards_total} loaded — {len(ds):,} samples")
        coord_post("/merge/progress", {
            "node_id": node_id,
            "shards_loaded": i,
            "shards_total": shards_total,
            "shard_name": shard.name,
        })

    merged = concatenate_datasets(datasets).shuffle(seed=42)
    log.info(f"[merge] total samples: {len(merged):,}")

    # save_to_disk accepts num_shards to control how many Parquet files the dataset
    # is split into (without it, HF auto-decides based on max_shard_size=500 MB).
    # We set it explicitly so the progress monitor knows the denominator.
    # Formula: ~1000 rows per shard gives fine-grained progress reporting,
    # clamped to [10, 1000] to avoid too few (coarse progress) or too many (filesystem overhead).
    num_shards = max(10, min(1000, len(merged) // 1000))
    log.info(f"[merge] saving to disk with {num_shards} shards ...")

    # save_to_disk can take tens of minutes for large datasets — keep the watchdog
    # happy by sending heartbeats in the background throughout the save loop.
    with heartbeat_ctx(node_id):
        for attempt in range(1, _MAX_SAVE_RETRIES + 1):
            if Path(FINAL_MERGED_OUTPUT).exists():
                shutil.rmtree(FINAL_MERGED_OUTPUT)

            log.info(f"[merge] save attempt {attempt}/{_MAX_SAVE_RETRIES} → {FINAL_MERGED_OUTPUT}")
            done_event = threading.Event()
            monitor = threading.Thread(
                target=_monitor_save_progress,
                args=(FINAL_MERGED_OUTPUT, node_id, num_shards, done_event),
                daemon=True,
                name="save-progress-monitor",
            )
            monitor.start()
            save_exc: Exception | None = None
            try:
                merged.save_to_disk(FINAL_MERGED_OUTPUT, num_shards=num_shards)
            except Exception as exc:
                save_exc = exc
            finally:
                done_event.set()
                monitor.join(timeout=5)

            if save_exc is not None:
                log.warning(f"[merge] save_to_disk raised on attempt {attempt}: {save_exc}")
                if attempt == _MAX_SAVE_RETRIES:
                    raise save_exc
                continue

            valid, reason = _validate_dataset(FINAL_MERGED_OUTPUT, len(merged))
            if valid:
                break
            log.warning(f"[merge] broken dataset on attempt {attempt}: {reason} — retrying")
            if attempt == _MAX_SAVE_RETRIES:
                raise RuntimeError(f"[merge] dataset broken after {_MAX_SAVE_RETRIES} attempts: {reason}")

    coord_post("/merge/save_progress", {"node_id": node_id, "pct": 100.0})
    log.info(f"[merge] saved to {FINAL_MERGED_OUTPUT}")
    return len(merged)


# ─────────────────────────────────────────
# ZIP / UPLOAD / DOWNLOAD HELPERS
# ─────────────────────────────────────────

def _zip_dataset(src_dir: Path, dest_zip: Path) -> int:
    """Archive *src_dir* into *dest_zip* using tar + zstd (multi-threaded, fast).

    Uses all available CPU cores via zstd -T0 --fast. Parquet files are already
    compressed so speed is prioritised over ratio.
    The archive root contains the directory name (e.g. final_dataset/…) so that
    extracting to any folder recreates the dataset directory at a predictable path.
    Returns archive size in bytes.
    """
    log.info(f"[merge] archiving {src_dir} → {dest_zip}")
    tar_proc = subprocess.Popen(
        ["tar", "-C", str(src_dir.parent), "-cf", "-", src_dir.name],
        stdout=subprocess.PIPE,
    )
    zstd_proc = subprocess.Popen(
        ["zstd", "-T0", "--fast", "-o", str(dest_zip)],
        stdin=tar_proc.stdout,
    )
    assert tar_proc.stdout is not None
    tar_proc.stdout.close()
    tar_rc = tar_proc.wait()
    zstd_rc = zstd_proc.wait()
    if tar_rc != 0 or zstd_rc != 0:
        raise RuntimeError(f"[merge] tar+zstd failed (tar={tar_rc}, zstd={zstd_rc})")
    size = dest_zip.stat().st_size
    log.info(f"[merge] archive done: {size:,} bytes ({size / 1024 / 1024:.1f} MB)")
    return size


def _zip_and_upload(endpoint: str, label: str, progress_stage: str) -> int:
    """Zip data/final_dataset/, upload to *endpoint*, delete the local zip.

    Reports "zipping" stage then upload progress to the coordinator.
    Returns zip size in bytes.
    """
    src = Path(FINAL_MERGED_OUTPUT)
    if not src.exists():
        log.warning(f"[merge] {src} not found — skipping {label} upload")
        return 0
    dest_zip = DATA_DIR3 / f"{label}.tar.zst"
    coord_post_nowait("/merge/transfer_progress", {
        "node_name": NODE_NAME, "stage": "zipping",
        "bytes_done": 0, "bytes_total": 0,
    })
    size = _zip_dataset(src, dest_zip)
    log.info(f"[merge] uploading {label} ({size:,} bytes)...")
    coord_upload_zip(endpoint, dest_zip, progress_node_name=NODE_NAME, progress_stage=progress_stage)
    dest_zip.unlink()
    log.info(f"[merge] {label} upload done")
    return size


def _zip_and_upload_partial(node_name: str) -> int:
    """Zip and upload this machine's local merge as a partial (non-shared FS)."""
    return _zip_and_upload(f"/merge/upload_partial/{node_name}", "partial", "uploading_partial")


def _zip_and_upload_final() -> int:
    """Zip and upload the final global merged dataset to the coordinator."""
    return _zip_and_upload("/merge/upload_final", "final", "uploading_final")


def _wait_for_partials(my_node_name: str, all_node_names: list[str], node_id: int) -> None:
    """Block until all other machines have uploaded their partial zips."""
    expected = set(all_node_names) - {my_node_name}
    if not expected:
        return
    log.info(f"[merge] waiting for partials from: {sorted(expected)}")
    while True:
        uploaded = set(coord_partials_status())
        pending = expected - uploaded
        if not pending:
            log.info("[merge] all partials ready")
            return
        log.info(f"[merge] still waiting for partials from: {sorted(pending)}")
        send_heartbeat(node_id, "merging")
        time.sleep(15)


def _download_and_integrate_partial(other_node_name: str) -> None:
    """Download another machine's partial zip, merge it into local final_dataset, then clean up."""
    log.info(f"[merge] downloading partial from '{other_node_name}'...")
    zip_path = coord_download_partial(other_node_name)  # progress reported inside coord_download_partial

    # Always extract to DATA_DIR3 — decompressed parquet can be much larger than the zip
    # and tmpfs may not have enough space even if the zip fit there.
    extract_dir = DATA_DIR3 / f"partial_{other_node_name}"
    log.info(f"[merge] extracting {zip_path.name} → {extract_dir}")
    coord_post_nowait("/merge/transfer_progress", {
        "node_name": NODE_NAME, "stage": "extracting",
        "bytes_done": 0, "bytes_total": 0, "peer": other_node_name,
    })
    extract_dir.mkdir(parents=True, exist_ok=True)
    result = subprocess.run(
        ["tar", "--use-compress-program", "zstd -d -T0", "-xf", str(zip_path), "-C", str(extract_dir)],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        raise RuntimeError(f"[merge] tar extraction failed: {result.stderr}")
    zip_path.unlink()

    dataset_dir = extract_dir / "final_dataset"
    if not dataset_dir.exists():
        # Fallback if archive layout differs
        dataset_dir = extract_dir

    log.info(f"[merge] loading partial dataset from {dataset_dir}")
    coord_post_nowait("/merge/transfer_progress", {
        "node_name": NODE_NAME, "stage": "integrating",
        "bytes_done": 0, "bytes_total": 0, "peer": other_node_name,
    })
    partial_ds = load_from_disk(str(dataset_dir))
    log.info(f"[merge] partial '{other_node_name}': {len(partial_ds):,} samples")

    current_ds = load_from_disk(FINAL_MERGED_OUTPUT)
    log.info(f"[merge] concatenating — current {len(current_ds):,} + partial {len(partial_ds):,}")
    merged = concatenate_datasets([current_ds, partial_ds])

    # datasets refuses to overwrite the directory it was loaded from — save to a temp
    # path, replace the original, then clean up.
    merged_tmp = FINAL_MERGED_OUTPUT + "_tmp"
    save_and_validate(merged, merged_tmp, f"integrate-partial-{other_node_name}")
    shutil.rmtree(FINAL_MERGED_OUTPUT)
    os.rename(merged_tmp, FINAL_MERGED_OUTPUT)
    log.info(f"[merge] after concat: {len(merged):,} samples")

    shutil.rmtree(extract_dir)
    log.info(f"[merge] cleaned up {extract_dir}")


# ─────────────────────────────────────────
# MAIN ORCHESTRATION
# ─────────────────────────────────────────

def run_post_merge(node_name: str, shared_fs: bool, node_id: int) -> None:
    """Orchestrate post-local-merge steps for the Merger worker of this machine.

    Decision tree:
    • Single machine in fleet → Final Merger → ZIP_AND_UPLOAD → QUIT
    • Multiple machines, no Final Merger claim → maybe ZIP_AND_UPLOAD partial → QUIT
    • Multiple machines, is Final Merger, shared FS → ZIP_AND_UPLOAD final → QUIT
    • Multiple machines, is Final Merger, no shared FS →
        download all partials + integrate → shuffle → ZIP_AND_UPLOAD final → QUIT

    Always ends in an infinite idle loop — the process never exits voluntarily.
    """
    all_node_names = coord_get_node_names()
    log.info(f"[merge] registered machines: {all_node_names}")

    # ── Single machine ────────────────────────────────────────────────────────
    if len(all_node_names) <= 1:
        log.info("[merge] single machine — uploading final dataset")
        _zip_and_upload_final()
        log.info("[merge] done — idling")
        while True:
            send_heartbeat(node_id, "idle")
            time.sleep(60)

    # ── Multiple machines: claim Final Merger ─────────────────────────────────
    is_final = coord_claim_final_merger()
    log.info(f"[merge] Final Merger claim: {'YES' if is_final else 'NO'}")

    if not is_final:
        if not shared_fs:
            log.info("[merge] not Final Merger + no shared FS — uploading partial")
            _zip_and_upload_partial(node_name)
        else:
            log.info("[merge] not Final Merger + shared FS — no upload needed")
        log.info("[merge] done — idling")
        while True:
            send_heartbeat(node_id, "idle")
            time.sleep(60)

    # ── Final Merger ──────────────────────────────────────────────────────────
    if shared_fs:
        log.info("[merge] Final Merger + shared FS — final merge already done, uploading")
        _zip_and_upload_final()
        log.info("[merge] done — idling")
        while True:
            send_heartbeat(node_id, "idle")
            time.sleep(60)

    # Final Merger, no shared FS: download each other machine's partial and integrate
    log.info("[merge] Final Merger + no shared FS — downloading and integrating all partials")
    other_names = [n for n in all_node_names if n != node_name]

    coord_post_nowait("/merge/transfer_progress", {
        "node_name": NODE_NAME, "stage": "waiting_partials",
        "bytes_done": 0, "bytes_total": 0,
    })
    _wait_for_partials(node_name, all_node_names, node_id)

    # download+extract+concat+save per partial, then final shuffle and upload — all
    # CPU/disk-bound and potentially hours-long.  Keep the watchdog happy throughout.
    with heartbeat_ctx(node_id):
        for other in other_names:
            log.info(f"[merge] integrating '{other}'...")
            _download_and_integrate_partial(other)

        # Final shuffle of the globally merged dataset
        log.info("[merge] final global shuffle...")
        coord_post_nowait("/merge/transfer_progress", {
            "node_name": NODE_NAME, "stage": "shuffling",
            "bytes_done": 0, "bytes_total": 0,
        })
        final_ds = load_from_disk(FINAL_MERGED_OUTPUT)
        final_ds = final_ds.shuffle(seed=42)
        shuffled_tmp = FINAL_MERGED_OUTPUT + "_tmp"
        save_and_validate(final_ds, shuffled_tmp, "final-global-shuffle")
        shutil.rmtree(FINAL_MERGED_OUTPUT)
        os.rename(shuffled_tmp, FINAL_MERGED_OUTPUT)
        log.info(f"[merge] final global dataset: {len(final_ds):,} samples")

        log.info("[merge] uploading final dataset to coordinator")
        _zip_and_upload_final()

    log.info("[merge] done — idling")
    while True:
        send_heartbeat(node_id, "idle")
        time.sleep(60)
