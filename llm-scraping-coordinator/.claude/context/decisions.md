
## 2026-03-31 20:56
Phase-watcher had phases inverted vs worker. Worker: phase1=queries, phase2=repos, phase3=stack. Coordinator was checking stack for phase1, queries for phase2, repos for phase3. Fixed to match worker.

## 2026-04-01 22:52
Shard-based batching: coordinator fetches HF Hub API for parquet shards (fetchHFDatasetFiles), seeds one task per shard via seedStackTasks(). Each shard completes in <1 min, giving natural zero-loss stop between tasks at wait_for_phase(3). Falls back to strided batching if HF API unreachable. Worker reads data_files field from task: if present loads single parquet shard (no strided filter), else uses legacy data_dir strided mode.

## 2026-04-01 23:13
Removed strided fallback from coordinator: if HF API unreachable at startup, seedStackTasks throws and coordinator exits with error. Reason: strided tasks would also fail to stream data, so fallback gave false safety. STACK_BATCH_COUNT removed as now unused.

## 2026-04-02 13:16
Refactored monolithic coordinator.mts (1140 lines) into layered modules. Merged dual Sentry.init calls into instrument.mts. Excluded src/static/ from ESLint (browser JS, not Node). Used explicit Router type annotations on exported router consts to satisfy NodeNext isolated modules constraint.

## 2026-04-04 11:55
Clear all merge Redis keys (merge_ready_node_ids, merge_status, merge_assigned_node, merge_assigned_nodes, merge_done_nodes, merge_node_samples, merge_shards_*, merge_last_shard) whenever phase transitions to 4. This prevents stale SADD results blocking every worker from being assigned the merge task on subsequent runs.

## 2026-04-04 18:12
Post-merge orchestration: single-machine fleet skips Final Merger claim and uploads directly. Multi-machine: SETNX atomic claim for Final Merger. Non-Final Mergers upload partial (no shared FS) then QUIT. Final Merger with shared FS zips/uploads directly; without shared FS polls for all partials, downloads+integrates one at a time (sequential to limit memory), does final shuffle, uploads. Coordinator self-terminates via SIGTERM (500ms delay to flush response) when all registered node_names have sent /merge/quit.

## 2026-04-04 19:11
Worker registration extended: /worker/register now accepts all_node_ids?: number[]. Main process sends all N thread node_ids at once; coordinator does Promise.all(hSet) for each. 409 guard on node_name unchanged. Backward compat when all_node_ids omitted.

## 2026-04-04 19:36
Removed TOTAL_WORKERS env var: replaced with registered:node_ids Redis SET (SET of node_id strings). Populated by /worker/register (all_node_ids). All status, watchdog, reset, merge routes now fetch IDs dynamically. Full reset clears the SET so fresh registrations work correctly.

## 2026-04-05 07:35
NODE_NAME (max 8 ASCII chars) and NODE_HASH (exactly 8 ASCII chars) required on /worker/register. Coordinator: not-registered → save both; registered+hash-match → crash recovery (re-register ids, 200 OK); registered+hash-mismatch → 409 name_taken. Worker: validates both locally at startup, quits with print() on 400 or 409. registered:node_hashes HASH key added; cleared on /reset/all and /reset/worker_names.

## 2026-04-05 08:20
Coordinator now assigns globally-unique node_ids: /worker/register accepts n_threads, atomically allocates IDs via INCRBY on registered:next_node_id, returns start_node_id. Worker derives all_ids = range(start_id, start_id+n). Crash recovery returns stored start_node_id from registered:node_offsets HASH. New keys: registered:node_offsets (HASH), registered:next_node_id (STRING counter). Both cleared on /reset/all and /reset/worker_names. Fixes dashboard showing only last-registered machine's workers.

## 2026-04-05 08:53
When auto-advancing and nextPhase is disabled: do NOT advance fleet_phase, only set fleet_state=stopped. Workers use wait_for_phase(N) which blocks on state=stopped — they idle correctly. Advancing fleet_phase to a disabled phase causes workers to exit (they check phase > N to decide to quit).

## 2026-04-05 16:00
Correct idle behavior when auto-advance on and nextPhase disabled: coordinator advances fleet_phase to nextPhase (3) but keeps state=stopped. Worker github.py: when fleet_phase>2+state=stopped, sleep+wait (don't break); only break when fleet_phase>2+state=running. wait_for_phase(2) unblocks immediately when fleet_phase>2, so workers reach the idle check correctly.

## 2026-04-05 16:24
JS static files (dashboard.js, redis-dashboard.js, reset-dashboard.js) now served with Cache-Control: no-store to prevent browser caching stale code after updates.

## 2026-04-05 16:31
Button never disabled when fleet stopped (except when all phases disabled). 'select a phase to run' is now a visual hint only, not a blocked state. Auto-picks first enabled phase if user clicks without selecting.

## 2026-04-05 16:39
Phase enable checkboxes now double as phase selectors when fleet is stopped after phases have run: enabling phase 3/4 selects it, disabling clears selection. This matches user mental model.

## 2026-04-05 17:03
Coordinator no longer self-terminates after phase 4 completes: /merge/quit handler sets state=done but keeps process alive so the download endpoint remains accessible. Download link /merge/download_final appears in dashboard only when merge:final_uploaded=1 (set in /merge/upload_final). Worker suppresses resource_tracker leaked-semaphore UserWarning by setting PYTHONWARNINGS env var before any multiprocessing operations — the resource_tracker subprocess inherits this setting.

## 2026-04-05 22:36
Phase 2 errors: fleet_phase stays at 2 (not advancing to 3) when repos_problematic > 0 — RETRY re-runs phase 2 in place. This differs from phase 3 (stack) which advances to phase 4 with error flag.

## 2026-04-05 23:33
When autoAdvance=1 and nextPhase is disabled, watchdog now loops (targetPhase++) to find the first enabled phase and starts it (state=running) instead of stopping. All-disabled case still stops at nextPhase.

## 2026-04-06 09:48
fleet:repos_file_error blocks phase-watcher when writing data/repos_found.txt fails. fleet:repos_file_written skips re-write after retry succeeds. POST /fleet/retry_repos_file re-runs write, on success clears error and sets state=running so watchdog advances on next tick. Dashboard shows amber RETRY WRITE REPOS FILE button when error is set.

## 2026-04-06 09:57
GITHUB_QUERIES now loaded from src/.github_queries.yaml instead of hardcoded in config.mts. Uses yaml package + readFileSync at module init. Path resolved via process.cwd() so it works for both dev (tsx) and prod (node dist/) since both are run from project root. Null entries from comment-only YAML list items are filtered out.

## 2026-04-06 11:03
Claude must NEVER write or restore .github_queries.yaml — it is a human-managed config file. Only humans edit it. The coordinator only reads it.

## 2026-04-06 11:16
Query generator uses star-range bisection to scan all repos: probe range, if >1000 bisect at midpoint and recurse, else fetch all pages. Ceiling 1_000_000 stars (no real repo exceeds this). Rate limits auto-waited via X-RateLimit-Reset.

## 2026-04-06 13:51
Abort startup (process.exit(1)) on missing repos_found.txt instead of setting Redis flag — coordinator must not run without the repo list. Batch endpoint /repos/batch/:nodeId returns 100 repos via sPop count, replacing single-repo /repos/next/:nodeId. /fleet/github_enabled added as alias for /fleet/repos_enabled to avoid breaking dashboard JS.

## 2026-04-06 14:09
init.mts: coordinator starts without repos_found.txt (warns instead of process.exit). Coordinator now always starts; phase 1 simply won't have repos to distribute until the file is populated via the Repo Scanner.

## 2026-04-06 14:52
Removed POST /queries/next endpoint and phase 1 query loop entirely. Repos are now pre-seeded from repos_found.txt — query-based discovery (github_search_repos, /queries/next) was dead code.

## 2026-04-06 17:12
Phase numbering is now 1=Repos, 2=Stack, 3=Merge (no queries phase). Repos sourced from data/repos_found.txt at startup/reset. /utility/repo-scanner/stream replaces /utility/github-queries/stream

## 2026-04-09 10:54
Per-phase threads stored as separate Redis hashes (registered:phase1_threads, registered:phase2_threads) keyed by node_name, alongside existing registered:node_offsets — gives dashboard exact phase-node mapping

## 2026-04-10 20:30
/merge/next was checking phase !== 4 (wrong) — merge is phase 3. Fixed to phase !== 3.

## 2026-04-10 20:43
Phase 3 (merge) uses data3/ folder exclusively. data/ is no longer used by merge. data/typescript in config.mts/stack-seeder.mts is a HuggingFace remote path, not local — unchanged.
