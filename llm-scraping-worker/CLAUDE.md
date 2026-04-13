@.claude/project-skills.md

# Context

## MANDATORY: Session Start Protocol

Read @docs/context/session-start-protocol.md

## MANDATORY: Saving Context

Read @docs/context/saving-context.md

# Development

## Environment Setup

Always activate conda environment before running any command:

```bash
eval "$(/home/app1/miniconda3/bin/conda shell.bash hook)"
conda activate /media/1TB/llm-scraping-main/llm-scraping-worker/envSFTW
```

## MANDATORY: Quality Checks

Before considering any task complete, always run:

```bash
eval "$(/home/app1/miniconda3/bin/conda shell.bash hook)"
conda activate /media/1TB/llm-scraping-main/llm-scraping-worker/envSFTW
ruff check . --fix
/home/app1/.local/bin/uv tool run mypy worker/ --ignore-missing-imports --disable-error-code import-untyped
```

> **Note:** use `uv tool run mypy` instead of the env's `mypy` — the compiled mypy 1.19.1
> crashes on Python 3.14.3 (`warnings._showwarnmsg_impl` removed). Also removed the stale
> `cd backend` (worker has no `backend/` subdirectory).

Fix any errors introduced by your changes before marking the task as done. Do this until no errors. Never run ruff with
--unsafe-fixes option.

## Codebase

The worker is a `worker/` package. Run with `python -m worker`. See `README.md` for user-facing docs.

```
worker/
  __init__.py
  __main__.py          ← entry point
  config.py            ← env vars, logging, sentry init, path constants
  coordinator.py       ← HTTP client, heartbeat, fleet state
  filtering.py         ← is_valid_code, dedup, GENERATED_SIGNALS, LANG_EXTENSIONS
  checkpoint.py        ← save_ckpt, load_ckpt, append_ckpt (atomic JSONL)
  streaming.py         ← stream_with_timeout, StackProgress, stack_progress_reporter
  fim.py               ← to_fim
  collectors/
    stack.py           ← collect_the_stack
    github.py          ← github_search_repos, clone_and_extract, collect_github
  main.py              ← main()
```

## Key Functions

| Function                                      | Module                      | Purpose                                                                                     |
|-----------------------------------------------|-----------------------------|---------------------------------------------------------------------------------------------|
| `is_valid_code(code, lang)`                   | `filtering`                 | Quality filter — rejects short/generated/non-TypeScript files                               |
| `dedup(samples)`                              | `filtering`                 | MD5-based deduplication within a sample list                                                |
| `coord_get(path)` / `coord_post(path, data)`  | `coordinator`               | Coordinator HTTP client with exponential-backoff retry                                      |
| `collect_the_stack()`                         | `collectors.stack`          | HuggingFace streaming pipeline (shard-based partitioning)                                   |
| `collect_github()`                            | `collectors.github`         | GitHub search + clone pipeline (coordinator-queued repos)                                   |
| `clone_and_extract(repo)`                     | `collectors.github`         | Shallow-clones to tmpfs, extracts `.ts`/`.mts`/`.cts`, returns samples or `None` on failure |
| `to_fim(code)`                                | `fim`                       | Formats code into Fill-in-the-Middle format for training                                    |
| `stream_with_timeout(iterable, item_timeout)` | `streaming`                 | Wraps any iterable with a per-item deadline via background thread                           |
| `save_ckpt` / `load_ckpt` / `append_ckpt`    | `checkpoint`                | Atomic JSONL checkpoint read/write                                                          |

## Non-Obvious Constraints

- **`SENTRY_DSN` is read at module load** (`sentry_sdk.init` runs before `main()`). Passing an empty string is valid;
  the SDK becomes a no-op.
- **Tmpfs is expected at `/mnt/tmpfs_repos`** for GitHub cloning. `clone_and_extract` logs a warning and falls back to
  disk if it's not mounted — it does not abort.
- **CodeSearchNet is intentionally not collected** (`csn_samples = []` in `main.py`). Don't restore it; the dataset is
  JavaScript-only.
- **Workers and coordinator never exit after merge** — after `run_post_merge` completes, the process stays alive and returns to idle, ready for the next operation triggered by the operator. Do not add `os._exit()` or any shutdown call at the end of `run_post_merge` or `main()`.
- **Checkpoints use atomic rename** (`.tmp` → final path). Never write checkpoint files directly.
- **Dedup is per-node only.** Cross-node dedup happens at dataset merge time, not here.
- **`/node/merge_ready` must be posted before `wait_for_phase(4)`** — it signals to the coordinator that this node's
  `ds.save_to_disk()` is complete. The coordinator's `/merge/next` will not assign the merge task until all peer nodes
  on the same machine have posted this signal. This prevents race conditions where the merge worker reads
  partially-written or missing `data/dataset_node*/` shards.
- **Partial zips use `ZIP_STORED`** (no compression) because parquet files are already compressed — re-compressing
  adds CPU time without reducing size.
- **Final Merger claim is first-wins and non-retryable** — `POST /merge/claim_final` uses `SETNX`; if your machine
  loses the race, it must upload a partial instead. The winner is recorded in `merge:final_merger` in Redis.
- **Partial integration is sequential** — `_download_and_integrate_partial` is called in a loop (not concurrently) to
  keep peak memory bounded. Each partial is downloaded, merged into the local `final_dataset/`, and deleted before the
  next one starts.

## Coordinator API (consumed by this worker)

```
POST /worker/register            ← { node_id, node_name, node_hash, all_node_ids? }
                                   → 200 ok (new or crash-recovery); 409 name_taken (hash mismatch); 400 invalid params
GET  /stack/next/{node_id}       → { task: { lang, data_dir, target_lang, batch_index, total_batches } | null }
POST /stack/done                 ← { lang, batch_index, node_id, samples }
POST /repos/register             ← { repos: [str], node_id }
GET  /repos/next/{node_id}       → { repo: str | null }
GET  /repos/batch/{node_id}      → { repos: str[] }  (up to 100 at once)
POST /repos/done                 ← { repo, node_id, samples }
POST /repos/fail                 ← { repo, node_id, reason }
POST /heartbeat                  ← { node_id, ... }
GET  /status                     → { github: { pending, assigned } }
POST /node/merge_ready                  ← { node_id }  (signal after ds.save_to_disk completes)
GET  /merge/next/{node_id}              → { task: { output_dir } | null }
POST /merge/progress                    ← { node_id, shards_loaded, shards_total, shard_name }
POST /merge/done                        ← { node_id, samples }
GET  /merge/node_names                  → { node_names: str[] }
POST /merge/claim_final                 ← { node_name } → { is_final_merger: bool }
POST /merge/upload_partial/{node_name}  ← zip body (raw bytes)
GET  /merge/partials_status             → { uploaded: str[] }
GET  /merge/download_partial/{node_name}→ zip body
POST /merge/upload_final                ← zip body (raw bytes)
```

## VCS

Mercurial (`.hg/`), not Git. Use `hg` commands.
