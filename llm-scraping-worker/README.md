# llm-scraping-worker

Distributed worker that collects TypeScript source code from HuggingFace datasets and GitHub to build a training dataset
for LLM fine-tuning (Fill-in-the-Middle format).

## Prerequisites

- Python 3.14+ (conda env recommended)
- A running coordinator HTTP server
- GitHub personal access token
- `sudo` access for tmpfs mount (GitHub pipeline)

```bash
conda create --prefix ./env python=3.14.3
conda activate ./env
uv pip install -r requirements.txt
```

## Environment Variables

| Variable          | Required | Description                                                                                                                                         |
|-------------------|----------|-----------------------------------------------------------------------------------------------------------------------------------------------------|
| `NODE_NAME`       | yes      | Machine name shown in the dashboard (max 8 printable ASCII chars, e.g. `APP1`, `N97_1`)                                                             |
| `NODE_HASH`       | yes      | Per-machine secret used for crash-recovery identity check (exactly 8 printable ASCII chars)                                                         |
| `COORDINATOR_URL` | yes      | Base URL of the coordinator server, e.g. `http://coordinator.lan:3981`                                                                              |
| `GITHUB_TOKEN`    | yes      | GitHub personal access token for search/clone API                                                                                                   |
| `HF_TOKEN`        | no       | HuggingFace token (needed for gated datasets)                                                                                                       |
| `SENTRY_DSN`      | no       | Sentry DSN for error tracking and tracing                                                                                                           |
| `THREADS_PHASE1`  | no       | Thread count for phase 1 (GitHub collection); defaults to `os.cpu_count()` if not set                                                               |
| `THREADS_PHASE2`  | no       | Thread count for phase 2 (Stack collection); defaults to `1` if not set                                                                             |
| `CLONE_TIMEOUT`   | no       | Git clone timeout in seconds. If unset, no timeout is applied — clone runs until completion. Set to a number (e.g. `1200`) to abort stalled clones. |
| `TMPFS_DIR`       | yes      | Path to the tmpfs ramdisk used for temporary git clones (e.g. `/mnt/tmpfs_repos`). Worker exits immediately if unset.                               |

Both `NODE_NAME` and `NODE_HASH` are validated at startup before any work begins. An invalid format or a coordinator
rejection causes the worker to print an error to stdout and exit immediately.

**Crash recovery**: if a worker restarts with the same `NODE_NAME` and `NODE_HASH` already present in the coordinator,
registration succeeds and the worker resumes normally. If the hash does not match (name already in use by a different
machine), registration is rejected with `409 name_taken` and the worker exits.

## Running

See `scripts/start_workers.sh` for run workers. Run it on every node (server) you want to use as worker.

All nodes collaborate automatically — start any subset, in any order.

## How It Works

### Phase flow

Workers execute phases determined by the coordinator. Each phase can be enabled or disabled independently from the
coordinator dashboard.

```
Phase 1  →  Phase 2  →  Phase 3
Repo        Stack       Merge
cloning     scraping    dataset
```

Workers poll `GET /fleet/state` and block until the coordinator sets the fleet to `running`. When stopped, workers
finish their current task and wait (polling every 5 s). While waiting, workers report `worker_status: "idle"` via
heartbeat so the coordinator dashboard shows a yellow **IDLE** badge. If the coordinator is unreachable, workers assume
running — transient network errors never stall the fleet.

Phases advance automatically when all work is consumed (if auto-advance is enabled on the coordinator), or manually
via the dashboard Start button.

### Phase 1 — Repo processing

Workers claim individual repos (`GET /repos/next/:nodeId`), shallow-clone to tmpfs (`/mnt/tmpfs_repos`) via
`git clone --depth=1`, extract `.ts`/`.mts`/`.cts` files, delete the clone, and report results
(`POST /repos/done` or `/repos/fail`). Phase 1 is complete when no repos remain pending or assigned.

If tmpfs is full (`no space left on device`), the worker automatically retries the clone in
`./data/data1/tmp_clone/` before reporting the repo as failed. Only if the data directory is also full is
the repo marked problematic. Every clone failure (exit code, timeout, or exception) is appended to
`./data/data1/error.log` for post-run inspection.

### Phase 2 — Stack scraping (HuggingFace)

Workers claim individual repos (`GET /repos/next/:nodeId`), shallow-clone to tmpfs (`/mnt/tmpfs_repos`) via
`git clone --depth=1`, extract files matching the extensions configured in the coordinator's `FILE_EXTENSIONS` env var
(default `.ts,.mts,.cts`), delete the clone, and report results (`POST /repos/done` or `/repos/fail`).
Phase 2 is complete when no repos remain pending or assigned.


**Where the task count comes from:** at reset/seed time the coordinator calls the HuggingFace Hub API
(`/api/datasets/bigcode/the-stack/tree/main/data/typescript`) and counts the `.parquet` shard files present in that
directory. One task is created per shard file × per language in `STACK_TASKS` (currently only `typescript`). The
resulting number — visible as "stack tasks" on the dashboard — reflects the live HF dataset at the moment of seeding
(e.g. 139 shards → 139 tasks). It is not a hardcoded constant.

### Phase 3 — Dataset merge

Phase 3 has two steps: **local merge** and **post-merge orchestration**.

#### Local merge

- Each worker calls `POST /node/merge_ready` immediately after its `ds.save_to_disk()` completes (or after skipping
  the save if collection is disabled). This signals to the coordinator that the node's shard is fully written.
- Workers then poll `GET /merge/next/:nodeId`. The coordinator will not assign the task until all workers on the same
  machine (non-shared FS) or all workers in the fleet (shared FS) have posted `/node/merge_ready` — preventing the
  merge worker from reading partially-written or missing shards.
- The one assigned worker (`collectors/merge.py: run_merge`) loads all `data/data1/dataset_node*/` and `data/data2/dataset_node*/`
  directories it can see, concatenates them, shuffles, and saves to `data/data3/final_dataset/`. It posts `/merge/progress`
  after each shard load.
- When done, the worker posts `POST /merge/done` with the sample count.
- Workers not assigned the merge task skip it silently.

**Shared filesystem** (coordinator setting): all workers see the same `./data/data1/`, `./data/data2/`, `./data/data3/`, so one worker
merges everything.

**No shared filesystem** (default): each machine merges only its own `data/data1/dataset_node*/` and `data/data2/dataset_node*/`
locally, producing a separate `data/data3/final_dataset/` per machine.

If collection phases are disabled (merge-only run), workers skip straight to phase 4 without overwriting previously
collected per-node datasets.

#### Post-merge orchestration

After the local merge the Merger worker (`collectors/merge.py: run_post_merge`) assembles a single global dataset
and uploads it to the coordinator. The coordinator self-terminates when all machines are done.

**Final Merger election**: the first machine's Merger to call `POST /merge/claim_final` wins the Final Merger role
(atomic `SETNX`). All others are regular Mergers.

Decision tree:

| Scenario                        | Regular Merger                                                          | Final Merger                                                                                         |
|---------------------------------|-------------------------------------------------------------------------|------------------------------------------------------------------------------------------------------|
| **Single machine**              | — (always the Final Merger)                                             | Pack `data/data3/final_dataset/` (tar.zst) → upload final → done                                          |
| **Multi-machine, shared FS**    | Done (no upload)                                                        | Pack/upload `data/data3/final_dataset/` (tar.zst) → done                                                  |
| **Multi-machine, no shared FS** | Pack local `data/data3/final_dataset/` (tar.zst) → upload as partial → done | Wait for all partials → download + integrate each sequentially → final shuffle → upload final → done |

**Partials flow** (multi-machine, no shared FS — the complex case):

1. Each non-Final Merger packs its local `data/data3/final_dataset/` as a tar.zst archive and uploads it to the coordinator via
   `POST /merge/upload_partial/:nodeName`.
2. The Final Merger polls `GET /merge/partials_status` (every 15 s) until all other machine names appear.
3. For each other machine the Final Merger downloads the archive (`GET /merge/download_partial/:nodeName`), extracts it
   to `data/data3/partial_{name}/`, runs `concatenate_datasets` to merge it into its local `data/data3/final_dataset/`, and
   deletes the extracted copy. Downloads are processed one at a time to keep peak memory bounded.
4. After all partials are integrated, the Final Merger applies a global shuffle and uploads the result via
   `POST /merge/upload_final` (saved on the coordinator host as `data/final_dataset.tar.zst`).
5. Once all uploads are complete, the coordinator sets the fleet state to `done`.

### Code quality filter

Files are rejected if they: are under 150 chars or 5 non-blank lines, have avg line length >200, contain >15% non-ASCII
characters, match lockfile/generated-file patterns, or lack TypeScript-specific features (type annotations, `import`/
`export`, etc.).

### Checkpointing

Completed phases write `.jsonl` files to `./data/data1/checkpoints_node{NODE_ID}/`. On restart, existing checkpoints are
loaded and skipped. Partial flushes happen every 50k samples. Writes are atomic (`.tmp` → rename).

### Deduplication

MD5-based, in-memory, scoped per node. Cross-node deduplication happens automatically during the phase 4 merge
(`concatenate_datasets` + shuffle — HuggingFace deduplicates identical Arrow rows).

## Output

Worker output is split across three data directories (`data/data1/`, `data/data2/`, `data/data3/`):

| Path                            | Content                                                                                                                         |
|---------------------------------|---------------------------------------------------------------------------------------------------------------------------------|
| `./data/data1/checkpoints_node{N}/`  | Incremental JSONL checkpoints                                                                                                   |
| `./data/data1/dataset_node{N}/`      | Per-node GitHub `Dataset` (Arrow, phase 1)                                                                                      |
| `./data/data1/crash_{NODE_NAME}.log` | Faulthandler crash log                                                                                                          |
| `./data/data1/error.log`             | Clone failure log: one line per failure with UTC timestamp, repo name, and error reason (clone exit code / timeout / exception) |
| `./data/data1/tmp_clone/`            | Temporary clone directory used as fallback when tmpfs is full; always cleaned up after extraction                               |
| `./data/data2/hf_cache_node{N}/`     | HuggingFace dataset cache                                                                                                       |
| `./data/data2/dataset_node{N}/`      | Per-node Stack `Dataset` (Arrow, phase 2)                                                                                       |
| `./data/data3/final_dataset/`        | Merged final dataset (written by phase 4)                                                                                       |
| `./data/data3/partial_*.tar.zst`     | Temporary partial archives downloaded from other machines during multi-machine merge                                           |

### Dataset schema

Each record in `data/data1/dataset_node{N}/`, `data/data2/dataset_node{N}/`, and `data/data3/final_dataset/` has three fields:

| Field    | Type   | Description                                                                                                |
|----------|--------|------------------------------------------------------------------------------------------------------------|
| `text`   | string | FIM-formatted code: `<\|fim_prefix\|>{prefix}<\|fim_suffix\|>{suffix}<\|fim_middle\|>{middle}<\|eot_id\|>` |
| `lang`   | string | Language tag, e.g. `typescript`                                                                            |
| `source` | string | Origin: `the-stack:{lang}` or `github:{owner/repo}`                                                        |
