import hashlib
import time
from pathlib import Path

import sentry_sdk
from datasets import load_dataset
from tqdm import tqdm

from worker.checkpoint import ckpt_exists, ckpt_path, save_ckpt
from worker.config import HF_TOKEN, log
from worker.coordinator import coord_get, coord_post, send_heartbeat, wait_for_phase
from worker.filtering import is_valid_code
from worker.streaming import StackProgress, stack_progress_reporter, stream_with_timeout


def collect_the_stack(node_id: int, cache_dir: str, checkpoints_dir: Path, stack_languages: frozenset[str]) -> None:
    log.info(f"[Node {node_id}] === THE STACK ===")

    while True:
        wait_for_phase(2, node_id)
        resp = coord_get(f"/stack/next/{node_id}")
        task = resp.get("task")
        if not task:
            log.info(f"  [node{node_id}] No Stack task available")
            send_heartbeat(node_id, "idle")
            break

        send_heartbeat(node_id)

        lang          = task["lang"]
        data_dir      = task["data_dir"]
        data_files    = task.get("data_files")
        target_lang   = task["target_lang"]
        batch_index   = task["batch_index"]
        total_batches = task["total_batches"]
        ckpt_name     = f"stack_{lang}_batch{batch_index}"

        if target_lang not in stack_languages:
            log.info(f"  [SKIP] {lang} — {target_lang!r} not in stack_languages")
            continue

        if ckpt_exists(ckpt_name, checkpoints_dir):
            log.info(f"  [SKIP] {ckpt_name}")
            n_existing = sum(1 for _ in open(ckpt_path(ckpt_name, checkpoints_dir), encoding="utf-8") if _.strip())
            coord_post("/stack/done", {"lang": lang, "batch_index": batch_index, "node_id": node_id, "samples": n_existing})
            continue

        with sentry_sdk.start_transaction(op="task", name=f"stack.{lang}.batch{batch_index}"):
            try:
                if data_files:
                    # Shard-based: load exactly one parquet file — completes in <1 min,
                    # enabling near-immediate zero-loss stops between tasks.
                    ds = load_dataset(
                        "parquet",
                        data_files={"train": f"hf://datasets/bigcode/the-stack/{data_files}"},
                        split="train",
                        token=HF_TOKEN,
                        cache_dir=cache_dir,
                        streaming=True,
                    )
                else:
                    # Legacy strided: streams the full dataset, selecting every
                    # total_batches-th item by index.  Kept for backward compatibility
                    # when the coordinator falls back to strided seeding.
                    ds = load_dataset(
                        "bigcode/the-stack",
                        data_dir=data_dir,
                        split="train",
                        token=HF_TOKEN,
                        cache_dir=cache_dir,
                        streaming=True,
                    )
            except Exception as e:
                sentry_sdk.capture_exception(e)
                log.error(f"  [ERROR] load_dataset {lang}: {e}")
                continue

            # Try to get the dataset total so progress can show % complete.
            total_items: int | None = None
            try:
                n = ds.info.splits["train"].num_examples
                if n:
                    total_items = n
            except Exception:
                pass

            samples: list[dict] = []
            seen_hashes: set[str] = set()
            progress = StackProgress(lang, batch_index, total=total_items)

            MAX_STREAM_RETRIES = 5
            stream_success = False
            for attempt in range(MAX_STREAM_RETRIES):
                if attempt > 0:
                    wait_secs = 30 * attempt
                    log.info(f"  [RETRY {attempt}/{MAX_STREAM_RETRIES - 1}] node{node_id} {lang} batch{batch_index} — retrying stream in {wait_secs}s (kept {len(samples):,} samples so far)")
                    time.sleep(wait_secs)
                    # Reload the dataset stream for this attempt.
                    try:
                        if data_files:
                            ds = load_dataset(
                                "parquet",
                                data_files={"train": f"hf://datasets/bigcode/the-stack/{data_files}"},
                                split="train",
                                token=HF_TOKEN,
                                cache_dir=cache_dir,
                                streaming=True,
                            )
                        else:
                            ds = load_dataset(
                                "bigcode/the-stack",
                                data_dir=data_dir,
                                split="train",
                                token=HF_TOKEN,
                                cache_dir=cache_dir,
                                streaming=True,
                            )
                    except Exception as load_e:
                        sentry_sdk.capture_exception(load_e)
                        log.error(f"  [RETRY load_dataset failed] {lang}: {load_e}")
                        continue

                stop_reporter = stack_progress_reporter(progress, node_id, interval=10)
                try:
                    for idx, ex in enumerate(tqdm(
                        stream_with_timeout(ds, item_timeout=300),
                        desc=f"  {lang} batch{batch_index}",
                        total=total_items,
                    )):
                        # Update stream position on every iteration so the heartbeat always
                        # reflects current progress, regardless of how often valid samples
                        # are found.
                        progress.update(idx, len(samples))

                        # Strided filter: only applicable in legacy strided mode.
                        # Shard-based tasks load exactly one parquet file so every item belongs
                        # to this task — no filtering needed.
                        if not data_files and idx % total_batches != batch_index:
                            continue
                        content = ex.get("content", "")
                        if not is_valid_code(content, target_lang):
                            continue
                        h = hashlib.md5(content.encode("utf-8", errors="ignore")).hexdigest()
                        if h in seen_hashes:
                            continue
                        seen_hashes.add(h)
                        samples.append({
                            "content": content,
                            "source": f"the-stack:{lang}",
                            "lang": target_lang,
                        })
                        if len(samples) % 50_000 == 0:
                            log.info(f"  [auto-ckpt] node{node_id} {len(samples):,} samples...")
                            save_ckpt(f"{ckpt_name}_partial", samples, checkpoints_dir)
                    stream_success = True
                    break
                except TimeoutError as e:
                    sentry_sdk.capture_exception(e)
                    log.error(f"  [TIMEOUT attempt {attempt + 1}] node{node_id} {lang} stream stalled after {len(samples):,} samples: {e}")
                except Exception as e:
                    sentry_sdk.capture_exception(e)
                    log.error(f"  [STREAM ERROR attempt {attempt + 1}] node{node_id} {lang} error after {len(samples):,} samples: {e}")
                finally:
                    stop_reporter.set()

            if not stream_success:
                log.error(f"  [GIVING UP] node{node_id} {lang} batch{batch_index} failed after {MAX_STREAM_RETRIES} attempts — saving {len(samples):,} partial samples")
                if samples:
                    save_ckpt(ckpt_name, samples, checkpoints_dir)
                    coord_post("/stack/done", {"lang": lang, "batch_index": batch_index, "node_id": node_id, "samples": len(samples)})
                continue

            save_ckpt(ckpt_name, samples, checkpoints_dir)
            ckpt_path(f"{ckpt_name}_partial", checkpoints_dir).unlink(missing_ok=True)
            coord_post("/stack/done", {"lang": lang, "batch_index": batch_index, "node_id": node_id, "samples": len(samples)})
            log.info(f"  {lang}: {len(samples):,} samples")
