# LLM Scraping Coordinator

A central HTTP coordinator for a distributed LLM training data scraping operation. Up to 29 worker nodes poll it to
receive work assignments and report results. The coordinator can start and stop the entire worker fleet at runtime
without restarting any process.

## What it does

Coordinates three phases of data collection and assembly:

1. **Phase 1 – Repo processing**: Workers claim and process repos from the queue. The queue is seeded at startup from
   `input_data/repos_found.txt` (one `owner/repo` per line). Populate that file before the first run using the Repo Scanner
   utility (`GET /queries-gen`).
2. **Phase 2 – Stack scraping**: Workers claim dynamic batches from `bigcode/the-stack` (HuggingFace) and stream
   TypeScript files from the dataset.
3. **Phase 3 – Dataset merge**: One worker per machine (or one globally on a shared filesystem) concatenates all
   per-node Arrow datasets into a single `data/final_dataset/`.

Each phase can be enabled or disabled independently from the dashboard. Phases advance automatically when all work is
done (if auto-advance is on) or manually via the dashboard button. If auto-advance is on but the completed phase had
errors (e.g. phase 3 ended with problematic stack tasks), the pipeline halts and waits for manual intervention instead
of advancing.

All state lives in a Redis Cluster. The coordinator is a single-file Koa HTTP server (`src/coordinator.mts`).

## Running

```bash
# Direct run
yarn install && yarn start

# Type-check
npx tsc

# Lint
npx eslint src/
```

## Configuration

### Optional for development

Copy `.env.local.example` to `.env.local` and set:

| Variable     | Default      | Description                                    |
|--------------|--------------|------------------------------------------------|
| `SENTRY_DSN` | —            | Report crash in CC saving context program      |


### Program env vars

Copy `.env.example` to `.env` and set:

| Variable              | Default      | Description                                    |
|-----------------------|--------------|------------------------------------------------|
| `THE_STACK_LANGUAGES` | `typescript` | Comma-separated `target_lang` values workers may collect from The Stack (e.g. `typescript,javascript`). Exposed to workers via `GET /config`. |
| `REDIS_IS_CLUSTER`    | —            | Set to `true` for Redis Cluster mode           |
| `REDIS_DB1_HOST/PORT` | —            | Redis node 1 (`db1`)                           |
| `REDIS_DB2_HOST/PORT` | —            | Redis node 2 (`db2`)                           |
| `REDIS_DB3_HOST/PORT` | —            | Redis node 3 (`db3`)                           |
| `REDIS_USERNAME`      | —            | Redis auth username                            |
| `REDIS_PASSWORD`      | —            | Redis auth password                            |
| `REDIS_KEY`           | —            | Key prefix for all Redis keys                  |
| `HF_TOKEN`            | —            | HuggingFace token (for stack shard enumeration)|
| `GITHUB_TOKEN`        | —            | GitHub personal access token — raises the Search API rate limit from 10 to 30 req/min; used by the query generator utility |
| `SENTRY_DSN`          | —            | Sentry/Bugsink DSN for error reporting         |
| `SENTRY_ENVIRONMENT`  | `production` | Sentry environment tag                         |

## Architecture

### Backend state

Redis Cluster (3 nodes: `db1`, `db2`, `db3`). All keys use hash tags (`{repos}`, `{queries}`, `{stack}`, `{node}`) to
keep related keys on the same cluster slot for multi-key operations.

### Task queues

**Repos** (`{repos}:pending` SET / `{repos}:assigned` ZSET)

- Seeded at startup (and on reset) from `input_data/repos_found.txt` — one `owner/repo` per line
- If the file is missing or empty, the coordinator logs a warning and the queue starts empty; use the **Repo Scanner**
  utility (`GET /queries-gen`) to generate and save `repos_found.txt` before starting phase 1
- ZSET score is assignment timestamp; a watchdog reclaims stalled repos (>30 min) every 60s
- `POST /repos/fail` moves the repo to `{repos}:problematic`; use `POST /reset/repos_problematic` to re-queue

**Stack** (`{stack}:pending` LIST)

- Any worker can claim any batch — no static per-worker assignment
- Each batch carries `{batch_index, total_batches}` so workers know which slice to process (
  `item_id % total_batches === batch_index`)
- Assignment tracked in `{stack}:assigned` ZSET + `{stack}:assigned_tasks` HASH
- Timed-out tasks (>45 min with no `/stack/done`) move to `{stack}:problematic` — not re-queued automatically

**Merge** (`merge:*` keys)

- Phase 3 assigns one merge task per machine (NODE_NAME), or a single task globally on a shared filesystem
- Assignment is atomic via Redis `SADD` (no-shared-FS) or `SET` (shared-FS): only one worker per eligible group wins
- `registered:node_names` SET tracks every NODE_NAME that has ever called `/worker/register` — used to determine when
  all machines have completed their merge and to trigger coordinator self-termination
- `merge:ready_node_ids` SET: workers add their node_id via `POST /node/merge_ready` after `save_to_disk` completes.
  `GET /merge/next` will not assign a task until all peer node_ids on the same machine (non-shared FS) or all node_ids
  in the fleet (shared FS) are present — prevents the merge worker from reading partially-written shards
- `merge:final_merger` STRING: set via `SETNX` by the first machine to call `POST /merge/claim_final` — that machine
  is responsible for assembling the global dataset
- `merge:partial_uploads` SET: each non-Final Merger machine name is added here after uploading its partial archive;
  the Final Merger polls this set to know when all partials are ready to download

### Worker model

- Workers identify by `nodeId` (integer, starting from 1 per machine) and `node_name` (machine name, max 8 printable
  ASCII chars, e.g. `APP1`, `N97_1`)
- Each machine also sends a `node_hash` (exactly 8 printable ASCII chars) on registration. If the name is already
  registered and the hash matches, the machine is allowed to re-register (crash recovery — node_ids and stats are
  refreshed). If the hash does not match, the request is rejected with `409 name_taken` and the worker exits.
- Node names are registered at startup and stored in `{node}:N:stats`, `registered:node_names`, and
  `registered:node_hashes`
- Repo and query assignment uses Redis `SPOP` for atomic single-assignment
- Workers send heartbeats with a 5-min TTL; can include `current_stack`, `stack_scanned`, `stack_samples` progress
  fields

### Watchdogs

- **Repo timeout**: every 60s, reclaims repos stalled >30 min back to pending
- **Stack timeout**: every 5 min, marks tasks with no completion in >45 min as problematic
- **Phase watcher**: every 5s, checks if current phase is complete and advances (or auto-advances if enabled). If
  auto-advance is on but the phase completed with errors, sets `fleet:state=stopped` and `fleet:phase_error=1` instead
  of advancing — dashboard shows a red banner
- **Dead worker**: every 2 min, reports to Sentry any worker with no heartbeat for >5 min

### Init / idempotency

On first run, seeds Redis with repos (from `input_data/repos_found.txt`) and stack batches. Checks for existing data before seeding — safe to restart.

## HTTP API

### Worker endpoints

| Method | Path                    | Description                                                                        |
|--------|-------------------------|------------------------------------------------------------------------------------|
| `GET`  | `/health`               | Liveness check                                                                     |
| `GET`  | `/status`               | Full JSON state                                                                    |
| `POST` | `/worker/register`      | Register a worker node (`{node_id, node_name, node_hash, all_node_ids?}`); 409 if name taken with different hash; re-registers cleanly on crash recovery (same name+hash) |
| `POST` | `/heartbeat`            | Worker ping (5-min TTL); accepts `current_stack`, `stack_scanned`, `stack_samples` |
| `POST` | `/repos/register`       | Bulk-register repos (deduped against done/assigned)                                |
| `GET`  | `/repos/next/:nodeId`   | Assign next repo to worker                                                         |
| `GET`  | `/repos/batch/:nodeId`  | Assign up to 100 repos at once to worker                                           |
| `POST` | `/repos/done`           | Mark repo complete                                                                 |
| `POST` | `/repos/fail`           | Mark repo failed — moves to `{repos}:problematic`                                 |
| `GET`  | `/stack/next/:nodeId`   | Pop next available stack batch                                                     |
| `POST` | `/stack/done`           | Mark batch complete — body: `{lang, batch_index, node_id, samples}`                |
| `POST` | `/node/merge_ready`                  | Signal dataset save complete — body: `{node_id}`; required before merge is assigned |
| `GET`  | `/merge/next/:nodeId`                | Claim a merge task (one per machine, or one total on shared FS)                    |
| `POST` | `/merge/progress`                    | Report per-shard merge progress — body: `{node_id, shards_loaded, shards_total, shard_name}` |
| `POST` | `/merge/done`                        | Report local merge complete — body: `{node_id, samples}`                           |
| `GET`  | `/merge/node_names`                  | List all registered machine names (used in post-merge orchestration)               |
| `POST` | `/merge/claim_final`                 | Atomically claim the Final Merger role — body: `{node_name}`; returns `{is_final_merger}` |
| `POST` | `/merge/upload_partial/:nodeName`    | Upload a machine's local `final_dataset/` as a tar.zst archive (non-shared FS only)   |
| `GET`  | `/merge/partials_status`             | List machines that have uploaded a partial archive — returns `{uploaded: string[]}` |
| `GET`  | `/merge/download_partial/:nodeName`  | Download a previously uploaded partial archive                                       |
| `POST` | `/merge/upload_final`                | Upload the global final dataset tar.zst archive from the Final Merger               |

### Fleet control

| Method | Path                          | Description                                                              |
|--------|-------------------------------|--------------------------------------------------------------------------|
| `GET`  | `/fleet/state`                | Returns full fleet state: phase, enabled flags, merge settings, `phase_error` |
| `POST` | `/fleet/phase/start`          | Start the current phase (skips to first enabled phase)                   |
| `POST` | `/fleet/phase/stop`           | Stop phase; auto-advances if all work is done                            |
| `POST` | `/fleet/auto_advance`         | Enable/disable automatic phase advancement (`{enabled: boolean}`)        |
| `POST` | `/fleet/repos_enabled`        | Enable/disable phase 1 (repo processing) (`{enabled: boolean}`)         |
| `POST` | `/fleet/stack_enabled`        | Enable/disable phase 2 (HuggingFace Stack) (`{enabled: boolean}`)       |
| `POST` | `/fleet/merge_enabled`        | Enable/disable phase 3 (dataset merge) (`{enabled: boolean}`)           |
| `POST` | `/fleet/github_enabled`       | Alias for `repos_enabled` (legacy name, kept for compatibility)          |
| `POST` | `/fleet/merge_shared_fs`      | Shared filesystem mode: one global merge vs one per machine (`{enabled}`) |
| `POST` | `/fleet/merge_target_node`    | Pin merge to a specific NODE_NAME, or `""` for random (`{node_name}`)   |
| `POST` | `/fleet/start`                | Legacy: set fleet state to `running`                                     |
| `POST` | `/fleet/stop`                 | Legacy: set fleet state to `stopped`                                     |

Fleet state is stored in Redis (`fleet:state`, `fleet:phase`, `fleet:phase_error`, etc.). A missing `fleet:state` key
is treated as `"running"`. `fleet:phase_error` is `true` when auto-advance was halted because the phase completed with
errors; it is cleared by any reset operation or by starting the next phase manually. State changes are broadcast to
the dashboard via the SSE `/events` stream.

### Phase 3 — Dataset merge

Phase 3 runs after all collection phases complete and has two sub-steps: **local merge** and **post-merge
orchestration**.

#### Local merge

**Readiness gate**: before a merge task is assigned, all workers on the same machine (non-shared FS) or all workers in
the fleet (shared FS) must have posted `POST /node/merge_ready`. Workers do this immediately after `ds.save_to_disk()`
completes (or after skipping the save if collection is disabled). This prevents the merge worker from reading
partially-written or missing `data/dataset_node*/` shards due to concurrent saves.

One worker per machine is then assigned a local merge task via `GET /merge/next/:nodeId`. That worker concatenates
all `data/dataset_node*/` directories it can see into `data/final_dataset/`, then reports completion via
`POST /merge/done`.

**Shared filesystem** (`fleet:merge_shared_fs = 1`): workers on all machines can see the same `./data/` directory.
One worker total is assigned the merge task; its `data/final_dataset/` is already globally complete.

**No shared filesystem** (default): each machine has its own local `./data/`. One worker per machine
(NODE_NAME group) is assigned a local merge task; each produces a local `data/final_dataset/` containing only
that machine's shards.

**Target node** (`fleet:merge_target_node`): when set to a NODE_NAME (e.g. `app1`), only workers from
that machine are eligible for the merge task. Leave empty to let any worker claim it.

#### Post-merge orchestration

After the local merge the Merger worker (one per machine) enters post-merge orchestration to assemble a single global
dataset and upload it to the coordinator. The coordinator self-terminates once all machines have finished.

**Final Merger election**: the first machine to call `POST /merge/claim_final` wins the Final Merger role (atomic
`SETNX`). All other machines are regular Mergers.

The decision tree for each machine's Merger worker:

| Scenario | Merger (non-Final) | Final Merger |
|---|---|---|
| **Single machine** | — (only one machine, it is the Final Merger) | Pack `data/final_dataset/` (tar.zst) → `POST /merge/upload_final` |
| **Multi-machine, shared FS** | No upload needed — Final Merger covers it | Pack/upload `data/final_dataset/` (tar.zst) |
| **Multi-machine, no shared FS** | Pack local `data/final_dataset/` (tar.zst) → `POST /merge/upload_partial/:nodeName` | Wait for all partials → download each → integrate into local `final_dataset/` sequentially (memory-safe) → final shuffle → pack/upload |

**Partials flow** (multi-machine, no shared FS):
1. Non-Final Mergers pack their local `data/final_dataset/` as a tar.zst archive and `POST /merge/upload_partial/:nodeName` to the
   coordinator, which stores it at `data/partials/{nodeName}.tar.zst`.
2. The Final Merger polls `GET /merge/partials_status` until all other machine names appear in `uploaded`.
3. For each other machine, the Final Merger calls `GET /merge/download_partial/:nodeName`, extracts the archive, runs
   `concatenate_datasets` to integrate it into its local `data/final_dataset/`, then deletes the extracted copy.
   Integration is sequential (one partial at a time) to keep peak memory bounded.
4. The Final Merger applies a final global shuffle, then uploads the result via `POST /merge/upload_final`
   (stored at `data/final_dataset.tar.zst` on the coordinator host).

**Coordinator self-termination**: once all machines have completed their uploads (non-Final Mergers after partial upload, Final Merger after final upload), the coordinator sets `fleet:state = "done"` and `fleet:phase = 5`, then sends itself `SIGTERM` after a 500 ms flush delay.

### Dashboards & utilities

| Method | Path                        | Description                                                     |
|--------|-----------------------------|-----------------------------------------------------------------|
| `GET`  | `/`                         | Real-time SSE dashboard                                         |
| `GET`  | `/events`                   | SSE stream, pushes status JSON every 2s                         |
| `GET`  | `/redis`                    | Redis debug dashboard                                           |
| `GET`  | `/redis/data`               | Redis debug data as JSON                                        |
| `GET`  | `/redis/events`             | SSE stream for Redis dashboard, pushes every 5s                 |
| `GET`  | `/reset`                    | Reset control panel                                             |
| `POST` | `/reset/all`                | Wipe all Redis state and re-seed                                |
| `POST` | `/reset/stack`              | Wipe stack state, re-seed (skip already-done batches)           |
| `POST` | `/reset/phase/stack`        | Wipe stack phase + stats, re-seed                               |
| `POST` | `/reset/phase/repos`        | Wipe repo phase + stats, re-seed from `input_data/repos_found.txt`   |
| `POST` | `/reset/repos_problematic`  | Move problematic repos back to pending, clear failed counters   |
| `POST` | `/reset/phase/merge`        | Wipe merge phase state                                          |
| `POST` | `/reset/problematic`        | Move problematic stack tasks back to pending                    |
| `POST` | `/reset/worker_names`       | Clear worker name records                                       |
| `GET`  | `/queries-gen`              | Repo Scanner UI — scan GitHub repos and write `input_data/repos_found.txt` |
| `GET`  | `/utility/repo-scanner/stream` | SSE stream for the Repo Scanner — see below                |

#### Repo Scanner — `GET /utility/repo-scanner/stream`

Scans GitHub for repositories matching a language and minimum star count via recursive range bisection (works around
the GitHub Search API 1000-result cap). Writes all discovered `owner/repo` names to `input_data/repos_found.txt`.

Accepts query parameters:

| Parameter   | Type    | Default        | Description                              |
|-------------|---------|----------------|------------------------------------------|
| `language`  | string  | `typescript`   | GitHub language filter                   |
| `minStars`  | integer | `150`          | Minimum repository star count            |

**SSE event types:**

| Event    | `data` shape                      | Description                                          |
|----------|-----------------------------------|------------------------------------------------------|
| `log`    | `{ msg: string }`                 | Progress line (one per star range / page scanned)    |
| `result` | `{ count: number }`               | Scan complete — total repos written to file          |
| `error`  | `{ msg: string }`                 | Fatal error; stream closes immediately               |

If `GITHUB_TOKEN` is set in `.env`, all requests use it (30 req/min rate limit); otherwise requests are unauthenticated
(10 req/min). The UI shows which mode is active in the log.

## Observability

Sentry integration via `src/instrument.mts`. Patches HTTPS to disable cert verification for the local BugSink instance.

