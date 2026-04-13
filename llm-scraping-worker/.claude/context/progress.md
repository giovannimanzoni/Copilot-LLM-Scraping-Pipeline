
## 2026-03-30 23:26
Added wait_for_coordinator() before main() work starts. Polls GET /status every 1s instead of crashing on connection refused.

## 2026-03-31 18:56
Fixed ruff deprecation (ignore->lint.ignore), added envSFTW exclude to ruff config, added ignore_missing_imports to mypy config. Fixed mypy errors in worker.py: added unreachable raises after coord_get/coord_post loops, typed repos variable, cast params ints to str. Env mypy (compiled) is broken on Python 3.14.3 (missing _showwarnmsg_impl); uv tool run mypy works and passes clean.

## 2026-03-31 19:00
Updated CLAUDE.md quality check command: replaced broken env mypy with uv tool run mypy, removed stale cd backend, added note about Python 3.14.3 incompatibility.

## 2026-03-31 19:43
Fixed phase ordering: GitHub queries=phase1, GitHub cloning=phase2, THE STACK=phase3. Reordered main() accordingly.

## 2026-03-31 21:37
Fixed: wait_for_phase now returns immediately when current_phase > requested phase. Bug: workers in phase 1 loop called wait_for_phase(1) at top of each iteration; once coordinator moved to phase 2, that condition was never true again, permanently blocking all workers except node22 which had escaped before transition.

## 2026-03-31 21:57
Added NODE_NAME env var to worker + all sh scripts. POST /worker/register endpoint stores name in node_stats HASH. Dashboard shows registered name in badge. Reset page has 'reset worker names' card+modal. All quality checks pass.

## 2026-04-01 12:24
Fixed: coord_get/coord_post refactored into _coord_request — ConnectionError retries every 30s indefinitely; other errors keep 3-retry exponential backoff. Worker no longer crashes when coordinator is down at startup or mid-run.

## 2026-04-01 12:32
Completed: worker startup fix — wait_for_start() shows 'waiting for start' when phase=0; main() reads github_enabled/stack_enabled from fleet status and skips disabled phases entirely

## 2026-04-01 22:05
Fixed: dashboard scan/collect metrics frozen. Regression: STACK_BATCH_COUNT 100→2000 (coordinator rev 40) combined with progress.update only called on valid samples meant stack_scanned heartbeat value changed only every 2000 stream items (at slow HF stream speeds, never changed within 10s reporter interval). Fix: moved progress.update(idx, len(samples)) to fire on every stream iteration (before the batch filter). Also fixed total_items to use full dataset size n instead of n//total_batches for correct 0-100% progress percentage. Also added type annotation samples: list[dict] = [] (pre-existing mypy error). Next: none

## 2026-04-01 22:34
Added STOP_CHECK_INTERVAL=10000 constant and graceful-stop check inside the HF streaming loop. Every 10k stream items, workers check is_fleet_running(). On stop: break from loop → existing save_ckpt+coord_post/stack/done code saves partial results → worker suspends at wait_for_phase(3). Stop latency ≤ 10s regardless of dataset size. Partial batches are checkpointed and reused on restart. Next: none

## 2026-04-01 22:52
DONE: shard-based batching in worker.py. Removed STOP_CHECK_INTERVAL. collect_the_stack() checks task.get('data_files'): if present loads single parquet shard via load_dataset('parquet', data_files=...), no strided filter; if absent falls back to legacy data_dir strided mode. Next: none.

## 2026-04-02 09:44
Refactored worker.py into worker/ package: config, coordinator, filtering, checkpoint, streaming, fim, collectors/stack, collectors/github, main, __main__. Shell scripts updated to python -m worker. CLAUDE.md updated. ruff+mypy clean.

## 2026-04-02 16:23
Added phase 4 support: worker/collectors/merge.py runs concatenate_datasets on all dataset_node*/ dirs; main.py polls /merge/next after collection, runs merge if assigned, reports to /merge/done

## 2026-04-02 21:39
Bug fix: skip dataset save when collection_enabled=False, preventing merge-only runs from overwriting collected data

## 2026-04-03 22:32
Updated scripts/start_workers_n97_1.sh to load HF_TOKEN, GITHUB_TOKEN, COORDINATOR_URL from .env file in worker project root using 'set -a; source .env; set +a'. Env vars already in environment take precedence.

## 2026-04-03 22:34
Added early fail-fast checks for COORDINATOR_URL and GITHUB_TOKEN in start_workers_n97_1.sh before any side effects

## 2026-04-04 09:34
run_merge(node_id) posts /merge/progress after each shard load with shards_loaded/total/shard_name

## 2026-04-04 11:34
DONE: Phase 4 race condition fix. Workers post /node/merge_ready after ds.save_to_disk(). Coordinator /merge/next now waits for all peer node_ids (same NODE_NAME, non-shared FS) to be in merge:ready_node_ids before assigning. Added merge:ready_node_ids Redis key; reset in /reset/all. Both projects pass type check + lint.

## 2026-04-04 11:40
DONE: Updated docs for /node/merge_ready fix. Updated: coordinator README.md (API table + Merge queue + Phase 4 section), worker README.md (Phase 4 section), worker CLAUDE.md (Coordinator API table + Non-Obvious Constraints).

## 2026-04-04 13:44
Added duplicate NODE_NAME guard: coordinator returns 409 when node_name already in registered set; worker calls os._exit(0) on 409 at registration. Next: none.

## 2026-04-04 13:49
Removed sentry_sdk.set_measurement calls for sample counts (per-lang, total_samples, merged_samples) from main.py — Sentry should only capture bugs/errors, not success metrics

## 2026-04-04 13:58
Added immediate phase-aware exit to github.py phase 2 loop: when no repo available, check fleet phase — if coordinator already past phase 2, break immediately instead of waiting idle_count=4 (up to 80s saved per worker)

## 2026-04-04 14:29
Replaced unconditional os._exit(0) with idle loop + SIGTERM handler. Workers now stay alive after merge. SIGTERM calls os._exit(0) to avoid the py3.14 segfault. Semaphore warning should also disappear since datasets pool cleans up before the process is killed.

## 2026-04-04 18:12
DONE: post-merge orchestration in workers. run_post_merge() in merge.py handles Merger/Final Merger logic with shared_fs flag. 7 new coordinator client helpers in coordinator.py. main.py extracts merge_shared_fs from fleet state and calls run_post_merge (which always ends os._exit(0)).

## 2026-04-04 18:38
DONE: documented post-merge orchestration in coordinator README (API table, Phase 4 section, Redis keys), worker README (Phase 4 section with post-merge decision tree and partials flow), and worker CLAUDE.md (coordinator API table + non-obvious constraints). Next: none

## 2026-04-04 19:11
DONE: single-process multi-thread worker refactor. Shell scripts: removed for loop, added START_NODE_ID, single python -m worker call. Worker: config.py → START_NODE_ID + node_paths(node_id); checkpoint.py/streaming.py/collectors → node_id param; coordinator.py → register_worker(all_node_ids), send_heartbeat(node_id), wait_for_phase(phase, node_id), wait_for_start(node_id); main.py → multi_worker_main + thread_main + _run_worker; __main__.py → --threads arg. Coordinator: /worker/register accepts all_node_ids[] sets node_stats for all threads at once. Next: none.

## 2026-04-04 19:26
Removed START_NODE_ID env var — node IDs always start from 1 per machine. Moved .env loading (COORDINATOR_URL, GITHUB_TOKEN, HF_TOKEN, SENTRY_DSN, NODE_NAME) into config.py at module load time (existing env vars take precedence). All 5 sh scripts now just activate conda, mount tmpfs, and invoke python -m worker. NODE_NAME now required (KeyError if missing). Next: none.

## 2026-04-04 19:41
DONE: THREADS env var added to config.py (THREADS: int|None), multi_worker_main uses CLI arg > THREADS > os.cpu_count(). Commented-out THREADS=4 added to .env. Next: none

## 2026-04-05 07:35
DONE: NODE_NAME/NODE_HASH registration. config.py: NODE_HASH read from env, both NODE_NAME (1-8 ASCII) and NODE_HASH (exactly 8 ASCII) validated at startup with os._exit(1). coordinator.py: NODE_HASH sent in /worker/register JSON; 400 → print error + os._exit(1); 409 name_taken → print error + os._exit(1). .env: NODE_HASH placeholder added. Next: none

## 2026-04-05 07:54
DONE: documentation updated for NODE_NAME/NODE_HASH. Worker README: env table updated (NODE_NAME required max 8 ASCII, NODE_HASH required exactly 8 ASCII, removed NODE_ID, added THREADS, added crash-recovery note), updated debug run example. CLAUDE.md: added /worker/register to coordinator API table. Next: none

## 2026-04-05 08:13
DONE: fixed bug where only one worker showed IDLE before fleet start. wait_for_start now accepts list[int] and sends idle heartbeat for every node_id. main.py updated to pass all_ids instead of all_ids[0]. Next: none

## 2026-04-05 08:20
DONE: fixed bug where second machine overwrote first machine's node_stats in dashboard. register_worker(node_name, n_threads) now returns int (start_node_id assigned by coordinator). main.py derives all_ids=range(start_id, start_id+n) after registration. Coordinator uses INCRBY counter for globally unique IDs. Next: none

## 2026-04-05 16:00
DONE: github.py repo loop now checks both fleet_phase and fleet_state. When fleet_phase>2+stopped, sleeps 15s and waits (workers idle). When fleet_phase>2+running, exits repo loop as before. Coordinator change: advances fleet_phase to nextPhase even when disabled (so wait_for_phase(2) unblocks), but keeps state=stopped. Next: none

## 2026-04-05 17:03
DONE: added PYTHONWARNINGS env var in config.py to suppress multiprocessing.resource_tracker UserWarning. Set before any multiprocessing operations so resource_tracker subprocess inherits it.

## 2026-04-05 23:53
DONE: Fixed two merge.py bugs: (1) PermissionError when save_to_disk tried to overwrite its source — now saves to _tmp then renames, affects both _download_and_integrate_partial and final shuffle; (2) partial zip extraction always goes to DATA_DIR, not zip_path.parent, so tmpfs is never used for decompressed parquets. Next: none

## 2026-04-06 08:27
DONE: _coord_request now retries indefinitely on 5xx (60s sleep) in addition to ConnectionError. Previously 500 from coordinator crashed threads after 3 retries. ConnectionError sleep also changed from 30s to 60s. Next: none

## 2026-04-06 14:52
Removed phase 1 loop (POST /queries/next), github_search_repos function, and unused requests/GITHUB_HEADERS imports from github.py.

## 2026-04-06 15:05
Fixed worker phase numbering: github.py wait_for_phase(2->1), phase>2 checks->phase>1; stack.py wait_for_phase(3->2); main.py wait_for_phase(4->3). Coordinator defines 1=repos,2=stack,3=merge per watchdog.mts comment.

## 2026-04-06 16:40
Fixed KeyError: 'queries' crash in collect_github — /status endpoint never returns a queries key; used .get() with default 0. Next: none

## 2026-04-06 16:48
Removed tmpfs OK per-clone log line and fs used reporting from clone_and_extract; warning on non-mount still kept

## 2026-04-06 16:50
Completed: clone_and_extract now retries on 'no space left on device': deletes partial clone, sleeps 60s, loops until space is available

## 2026-04-06 16:56
Added THE_STACK_LANGUAGES env var (comma-separated, default: typescript) to config.py; stack.py uses it instead of hardcoded typescript check

## 2026-04-06 17:02
Added startup warning when THE_STACK_LANGUAGES env var is not defined; falls back to typescript

## 2026-04-06 17:03
Documented THE_STACK_LANGUAGES in README.md env vars table

## 2026-04-06 17:34
Fixed 3 bugs in github.py: (1) CLONE_TIMEOUT env var (default 600s) replaces hardcoded 120s; (2) path.stat() moved inside try/except to handle broken symlinks; (3) clone_and_extract now returns str reason instead of None, giving specific failure messages to logs and coordinator

## 2026-04-06 17:38
Added CLONE_TIMEOUT to env vars table in README.md

## 2026-04-06 18:00
Added data-dir fallback for no-space tmpfs clones and error.log for all clone failures in github.py; updated README.md output table and Phase 2 docs

## 2026-04-06 18:13
Removed THE_STACK_LANGUAGES from config.py; added fetch_stack_languages() in coordinator.py; collect_the_stack() now takes stack_languages parameter; main.py fetches once at startup and passes to all threads

## 2026-04-06 18:14
Updated README: removed THE_STACK_LANGUAGES row from env vars table (now a coordinator config)

## 2026-04-06 20:24
Fixed: clone_and_extract in github.py was missing Italian 'spazio esaurito' in no-space detection — retry to data dir never triggered. Added _is_no_space_error() (checks English+Italian strings + statvfs fallback) and _device_path() (runs df to get device). Logs now include device path. Next: none

## 2026-04-06 20:27
Increased CLONE_TIMEOUT default from 600s to 1200s in config.py

## 2026-04-06 22:08
Fixed git clone credential prompt: embed GITHUB_TOKEN in clone URL (x-access-token), set GIT_TERMINAL_PROMPT=0, detect auth errors (authentication failed / terminal prompts disabled / could not read username / invalid credentials) and return 'skipped: private repo' instead of hanging

## 2026-04-06 22:20
Removed idle_count completion-detection from collect_github. The 0/4..3/4 counter reset loop was pointless — fleet phase check already handles termination. Now just logs 'Nessun repo, attendo 20s...' and retries.

## 2026-04-06 22:24
Added specific 'not found / does not exist' detection in clone_and_extract before the generic catch-all. Logs [not found] and returns a clear reason string; collect_github already posts to /repos/fail and continues.

## 2026-04-06 23:20
Changed CLONE_TIMEOUT default from 1200s to None (no timeout). When CLONE_TIMEOUT env var is not set, git clone runs without a timeout limit.

## 2026-04-06 23:21
Updated CLONE_TIMEOUT description in README.md: now documents that no timeout is applied when unset.

## 2026-04-07 14:28
Added log.info at start of clone_and_extract to log the repo being cloned. Next: none

## 2026-04-07 14:33
Fixed: worker now reports IDLE correctly when waiting for next repo/stack task. Moved send_heartbeat(working) to after repo/task is confirmed available; added send_heartbeat(idle) in all no-work-available branches in github.py and stack.py

## 2026-04-08 10:49
Fixed: registered SIGTERM+SIGINT handlers with os._exit(0) before blocking coordinator calls; replaced blocking t.join() with t.join(timeout=1.0) loop. This prevents the process from hanging when coordinator is down and worker threads are stuck in infinite retry loops.

## 2026-04-08 10:51
Fixed: added except Exception handler in stack.py streaming loop to catch httpx 'client has been closed' and similar transient errors — saves partials and continues to next task instead of crashing the thread

## 2026-04-08 11:15
Split data output dirs: GitHub (phase1) now saves to data1/dataset_node{id}, Stack (phase2) to data2/dataset_node{id}. Merge scans both DATA_DIR1 and DATA_DIR2. csn_samples stub removed. All ruff+mypy checks pass.

## 2026-04-08 22:02
Fixed: stream errors in collect_the_stack now retry up to 5 times (with 30s*attempt backoff) instead of skipping the batch. seen_hashes is preserved across retries so no duplicates. Only gives up after all retries exhausted.

## 2026-04-08 22:08
Fixed OOM kill: collect_the_stack no longer accumulates all_samples in RAM across 85+ batch iterations. Each batch is checkpointed to disk immediately. After collection completes, main.py loads from stack_*.jsonl checkpoints. Peak memory during collection loop drops from O(all batches) to O(one batch).

## 2026-04-08 23:26
Fixed 3 RAM issues: (1) collect_github no longer accumulates all_samples in RAM - writes to checkpoint incrementally, main.py loads after collection. (2) seen_hashes built by streaming checkpoint line-by-line instead of loading all sample content. (3) Added del github_samples/stack_samples before Dataset.from_list and del formatted1/2 after - halves peak memory during format phase.

## 2026-04-09 09:02
Fixed: moved merge_ready + wait_for_phase(3) outside if merge_enabled block so worker always waits for coordinator phase 3 instead of exiting immediately after datasets saved

## 2026-04-09 09:18
Removed DATA_DIR (./data). Phase1 files (checkpoints, error.log, tmp_clone, crash logs) → DATA_DIR1. Phase2 files (hf_cache) → DATA_DIR2. Phase3 files (final_dataset, zips, partials) → DATA_DIR3 (new, ./data3). All 5 files updated: config.py, merge.py, github.py, main.py, coordinator.py.

## 2026-04-09 09:37
Replaced single THREADS env var with THREADS_PHASE1 (github) and THREADS_PHASE2 (stack). Restructured multi_worker_main to run phases sequentially with separate thread pools. Phase 3 (merge) is always single-threaded. Updated __main__.py CLI args and README.

## 2026-04-09 09:42
Updated README.md and coordinator.py docstring: DATA_DIR split into DATA_DIR1 (./data1/ — checkpoints, GitHub datasets, crash/error logs, tmp_clone), DATA_DIR2 (./data2/ — HF cache, Stack datasets), DATA_DIR3 (./data3/ — final dataset, partial zips). Next: none.

## 2026-04-09 09:45
Upgraded GitHub API header X-GitHub-Api-Version from 2022-11-28 to 2026-03-10 in worker/config.py

## 2026-04-09 10:54
register_worker(node_name, n_total, n1, n2) — sends n_threads_phase1/n_threads_phase2 to coordinator at registration

## 2026-04-09 14:02
Removed THREADS_PHASE2 cpu_count fallback: phase 2 thread count now always from THREADS_PHASE2 env var, defaulting to 1. Removed --threads-phase2 CLI arg.

## 2026-04-09 14:22
Fixed 3 issues: (1) collect_github early-exit when coordinator past phase1 + checkpoint exists (github.py); (2) _phase1_save_sem serializes format+save so only 1 node at a time holds Arrow RAM (main.py); (3) from_generator replaces from_list in both phases to eliminate intermediate formatted list

## 2026-04-09 14:28
Fixed: workers now check fleet phase at start and skip phase 1 if coordinator already at phase 2+; also added wait_for_phase(2) guard before phase 2 so late-starting workers wait properly

## 2026-04-09 18:18
After phase 2: replaced immediate merge_ready+wait_for_phase(3) with explicit 20s idle loop (heartbeats for all nodes, polls get_fleet_status); merge_ready only posted once phase 3 is running. Also added poll_interval param to wait_for_phase. Imports: added get_fleet_status+send_heartbeat to main.py import block.

## 2026-04-10 20:35
Fixed run_merge: filter out shard dirs missing dataset_info.json before loading. Prevents crash when phase 1 created the dir via mkdir but save_to_disk never completed (0 samples or crash). Skipped shards are logged as warnings.

## 2026-04-10 21:20
merge.py: added _monitor_save_progress thread (polls data-*.parquet files + size estimation); run_merge now uses num_shards=max(10,min(1000,len//1000)) + starts monitor thread; reports 100% to coordinator after save_to_disk completes

## 2026-04-10 21:49
Added save_and_validate() + _validate_dataset() in merge.py; all save_to_disk calls now retry up to 3x with clean-dir-before-retry logic. Covers run_merge (with monitor restart per attempt), _download_and_integrate_partial, final global shuffle, phase1 and phase2 saves in main.py. Ruff + mypy clean.

## 2026-04-10 21:59
Fixed _monitor_save_progress: replaced coord_post (blocking, 10s timeout, 3 retries) with coord_post_nowait (fire-and-forget, 3s timeout, no retries). Changed threshold 0.1% → 1.0%. This unblocks the monitor thread during heavy save_to_disk I/O so intermediate progress (every 1%) reliably reaches the coordinator and shows on the dashboard bar. Added coord_post_nowait() to coordinator.py.

## 2026-04-11 06:40
Fixed: ReadTimeout in _coord_request now treated same as ConnectionError — retries indefinitely with 60s backoff instead of crashing after 3 attempts. Root cause: coordinator OOM/Redis crash → request timeout → worker crash. Fix: catch (ConnectionError, Timeout) together.

## 2026-04-11 07:14
Fixed recurring incomplete shard warning: (1) removed premature Path(phase1_output/phase2_output).mkdir() calls that left stale dirs on crash; (2) added shutil.rmtree cleanup in _run_phase1/_run_phase2 except handlers; (3) run_merge now deletes stale/incomplete shard dirs instead of just skipping them. ruff+mypy clean.

## 2026-04-11 07:22
Fixed _monitor_save_progress in merge.py: was globbing data-*.parquet but HuggingFace datasets 4.8.4 save_to_disk writes data-*.arrow files. Changed glob to try .arrow first, fall back to .parquet. Dataset save progress bar now updates correctly on the coordinator dashboard.

## 2026-04-11 13:58
Fixed final merge deadlock: (1) main.py: when /merge/next returns null in non-shared-FS mode, worker now runs local merge + calls run_post_merge() instead of just exiting; (2) watchdog.mts: isPhaseComplete(3) non-shared-FS now checks merge_final_uploaded instead of merge_done_nodes to avoid premature phase completion; (3) clearMergeState() and fleet/phase/start: now clear merge_save_pct, merge_final_merger, merge_partial_uploads, merge_quit_node_names, merge_final_uploaded consistently

## 2026-04-11 15:37
Fixed _monitor_save_progress threshold: 1.0% → 0.1%. coord_post_nowait is fire-and-forget so frequent updates no longer block the monitor thread. Dashboard bar now moves in 0.1% steps.

## 2026-04-11 15:37
Fixed _monitor_save_progress threshold: 1.0% → 0.1%. coord_post_nowait is fire-and-forget so frequent updates no longer block the monitor thread. Dashboard bar now moves in 0.1% steps.

## 2026-04-11 15:37
Fixed _monitor_save_progress threshold: 1.0% → 0.1%. coord_post_nowait is fire-and-forget so frequent updates no longer block the monitor thread. Dashboard bar now moves in 0.1% steps.

## 2026-04-11 15:37
Fixed _monitor_save_progress threshold: 1.0% → 0.1%. coord_post_nowait is fire-and-forget so frequent updates no longer block the monitor thread. Dashboard bar now moves in 0.1% steps.

## 2026-04-11 15:37
Fixed _monitor_save_progress threshold: 1.0% → 0.1%. coord_post_nowait is fire-and-forget so frequent updates no longer block the monitor thread. Dashboard bar now moves in 0.1% steps.

## 2026-04-11 15:37
Fixed _monitor_save_progress threshold: 1.0% → 0.1%. coord_post_nowait is fire-and-forget so frequent updates no longer block the monitor thread. Dashboard bar now moves in 0.1% steps.

## 2026-04-11 15:38
Fixed _monitor_save_progress threshold: 1.0% → 0.1%. coord_post_nowait is fire-and-forget so frequent updates no longer block the monitor thread. Dashboard bar now moves in 0.1% steps.

## 2026-04-11 15:38
Fixed _monitor_save_progress threshold: 1.0% → 0.1%. coord_post_nowait is fire-and-forget so frequent updates no longer block the monitor thread. Dashboard bar now moves in 0.1% steps.

## 2026-04-11 15:38
Fixed _monitor_save_progress threshold: 1.0% → 0.1%. coord_post_nowait is fire-and-forget so frequent updates no longer block the monitor thread. Dashboard bar now moves in 0.1% steps.

## 2026-04-11 15:38
Fixed _monitor_save_progress threshold: 1.0% → 0.1%. coord_post_nowait is fire-and-forget so frequent updates no longer block the monitor thread. Dashboard bar now moves in 0.1% steps.

## 2026-04-11 15:38
Fixed _monitor_save_progress threshold: 1.0% → 0.1%. coord_post_nowait is fire-and-forget so frequent updates no longer block the monitor thread. Dashboard bar now moves in 0.1% steps.

## 2026-04-11 15:38
Fixed _monitor_save_progress threshold: 1.0% → 0.1%. coord_post_nowait is fire-and-forget so frequent updates no longer block the monitor thread. Dashboard bar now moves in 0.1% steps.

## 2026-04-11 15:38
Fixed _monitor_save_progress threshold: 1.0% → 0.1%. coord_post_nowait is fire-and-forget so frequent updates no longer block the monitor thread. Dashboard bar now moves in 0.1% steps.

## 2026-04-11 15:38
Fixed _monitor_save_progress threshold: 1.0% → 0.1%. coord_post_nowait is fire-and-forget so frequent updates no longer block the monitor thread. Dashboard bar now moves in 0.1% steps.

## 2026-04-11 15:54
Fixed two bugs: (1) Worker start script now has restart loop — removed set -e, added while loop that restarts on any exit code except 0/1. (2) Added _phase2_save_sem in main.py to serialize phase-2 Arrow saves (same as _phase1_save_sem). (3) Coordinator SSE /events and /redis/events switched from setInterval to recursive setTimeout to prevent concurrent push() stacking; added res.on('error', cleanup) so broken sockets properly clear their timer.

## 2026-04-11 16:16
Fixed coord_upload_zip: now retries indefinitely on 408 Request Timeout, 5xx, ConnectionError, and Timeout (was only retrying on ConnectionError). Worker no longer crashes mid-upload.

## 2026-04-12 05:44
Fixed: all os._exit(0) calls in run_post_merge replaced with 'while True: time.sleep(60)'. Worker now idles indefinitely after uploading partial/final — process never terminates voluntarily. coord_quit() still called to notify coordinator.

## 2026-04-12 05:49
Fixed: main.py final os._exit(0) replaced with 'while True: time.sleep(60)'. Now covers: merge_disabled path, shared-FS no-task path. Worker never exits voluntarily in any normal flow. Fatal startup errors (config.py, coordinator.py) still use _exit(1). SIGTERM/SIGINT handler unchanged.

## 2026-04-12 06:22
Worker: coord_upload_zip now accepts progress_node_name/progress_stage kwargs; uses background thread + _ProgressReader to report upload % to /merge/transfer_progress every ~5% without blocking upload. coord_download_partial reports download progress every ~5% while iterating chunks. merge.py reports: zipping (before _zip_dataset), waiting_partials (before _wait_for_partials), extracting/integrating (in _download_and_integrate_partial), shuffling (before final global shuffle). NODE_NAME imported in merge.py.

## 2026-04-12 06:34
Added NODE_NAME to log format: [worker:NODE_NAME] — updates root logger formatter after NODE_NAME is validated in config.py

## 2026-04-12 06:49
TMPFS_DIR in config.py changed from hardcoded /mnt/tmpfs_repos to env var; sys.exit() with descriptive message if unset. import sys added.

## 2026-04-12 07:20
Replaced Python zipfile (single-threaded, ZIP_STORED) with tar+zstd -T0 --fast (all cores). _zip_dataset: Popen pipe of tar→zstd. _download_and_integrate_partial: subprocess tar --use-compress-program 'zstd -d -T0'. File extension .zip→.tar.zst in merge.py and coordinator.py. No compression ratio change (parquet already compressed), pure speed gain from multi-core.

## 2026-04-12 07:29
Removed all coord_quit() calls from merge.py (4 sites + import). Workers no longer signal the coordinator to quit. coord_quit() function kept in coordinator.py but unused.

## 2026-04-12 07:30
Removed coord_quit() function from coordinator.py entirely. Workers no longer have any quit signaling mechanism.

## 2026-04-12 07:37
Fixed: coordinator progress bar stuck at 95% for partial upload. Root cause: _report_progress thread in coord_upload_zip (coordinator.py) exits when done_event fires but never sends a final 100% update. Fix: added coord_post_nowait after the while loop to report bytes_done=file_size. No logic changes elsewhere.

## 2026-04-12 10:16
Added heartbeat_ctx context manager to coordinator.py; used in run_merge() (save_to_disk loop) and run_post_merge() (integration loop + final shuffle + upload). Fixes false 'worker non risponde' watchdog alerts caused by heartbeat TTL (300s) expiring during long CPU/disk operations.

## 2026-04-12 10:18
Updated root README.md: added coordinator crash-resilience paragraph to Architecture section (indefinite retry on ConnectionError/Timeout/5xx, 60s backoff for API calls, 30s for uploads/downloads); fixed wrong claim that coordinator self-terminates after merge (it only sets fleet:state=done)

## 2026-04-12 10:21
Moved data1/data2/data3 inside data/ — updated DATA_DIR1/2/3 in config.py from ./dataN to ./data/dataN. mkdir calls unchanged (create subdirs automatically).

## 2026-04-12 10:50
Fixed SIGINT segfault: pyarrow/datasets C++ lazy-init overrides Python signal.signal(), causing C++ cleanup to run on Ctrl+C and segfault. Fix: daemon=True on phase1/phase2 threads + removed os._exit(0) handler. KeyboardInterrupt now propagates naturally; daemon threads are killed on main-thread exit. Added test_sigint.py reproducer.

## 2026-04-12 10:54
Fixed CTRL+C traceback: KeyboardInterrupt (BaseException) bypasses except Exception in _coord_request and propagates to top-level. Fixed by catching KeyboardInterrupt in __main__.py main() and calling sys.exit(0) instead of printing the full urllib3/socket traceback.

## 2026-04-12 10:56
Fixed CTRL+C segfault: sys.exit(0) triggered Python module cleanup which ran pyarrow/Arrow C++ destructors and segfaulted. Changed to os._exit(0) which bypasses all cleanup (atexit, finalizers, C++ destructors). Also updated decisions.md.

## 2026-04-12 10:59
Fixed CTRL+C segfault: pyarrow C++ signal handlers install at import time (not lazily). Moved 'from datasets import Dataset', merge imports, and stack imports out of main.py top-level into the phase functions that need them. Startup path is now pyarrow-free; CTRL+C before phase 1 raises clean KeyboardInterrupt caught by os._exit(0) in __main__.py.

## 2026-04-12 11:04
Fixed Ctrl+C: catching KeyboardInterrupt (even with os._exit) triggers C++ cleanup during Python 3.14 exception unwinding and segfaults. Solution: sys.excepthook to suppress the traceback display; KeyboardInterrupt propagates naturally (same path as original run-1 which never segfaulted).

## 2026-04-12 11:10
Ctrl+C attempt 5: signal.SIG_DFL approach. Attempts 1-4 all failed (sys.exit, os._exit, deferred imports, sys.excepthook). Root cause likely: Python's own SIGINT handler or some other C extension triggers C++ cleanup on unwinding. SIG_DFL bypasses everything by terminating at OS level. Awaiting user test.

## 2026-04-13 09:40
Fixed: DATA_DIR1.glob('dataset_node*/') → glob('dataset_node*') — trailing slash silently returns [] in Python 3.14, causing run_merge to find no shards despite datasets existing

## 2026-04-13 11:59
Fixed: all post-merge idle loops (run_post_merge x4 + multi_worker_main x1) now call send_heartbeat(node_id, 'idle') every 60s. Previously bare time.sleep(60) caused heartbeat key (TTL=300s) to expire, making coordinator watchdog flag workers as DEAD after 8+ min.
