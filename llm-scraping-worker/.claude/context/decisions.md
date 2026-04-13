
## 2026-03-31 21:37
wait_for_phase returns when current_phase > phase (not just ==): callers naturally exit their loop via null response from coordinator API rather than blocking forever on phase transition

## 2026-04-01 12:24
Separated ConnectionError (coordinator unreachable) from other HTTP errors in coordinator client. ConnectionError retries indefinitely (30s sleep) because a coordinator restart should not kill the worker. Other errors (HTTP status, timeout) still fail after 3 retries.

## 2026-04-01 22:05
Regression: STACK_BATCH_COUNT default changed 100→2000 (coordinator rev 40). With 2000 batches, each batch processes 1/2000 of stream. progress.update(idx, len(samples)) was only called on valid samples → stack_scanned heartbeat value only updated when a TypeScript file passed all filters. At typical HF streaming speeds, valid batch-member samples appear rarely (every 2000 stream items), so 10s reporter interval fired with same value → dashboard appeared frozen. Fix: move progress.update to fire on every stream iteration (before batch membership check). Also fixed total_items = n (full dataset) instead of n//total_batches for correct percentage.

## 2026-04-01 22:34
Graceful-stop design: check is_fleet_running() every STOP_CHECK_INTERVAL stream iterations (not just batch items). This fires on ALL items so interval is wall-clock based, not batch-item based. Break from loop triggers existing save_ckpt+/stack/done which saves partial results. Workers then block at wait_for_phase(3). Restart loads checkpoint → batch marked done → no re-work. BATCH_COUNT does NOT control stop latency because each batch always streams the full dataset (strided sharding). Only the graceful-stop check does.

## 2026-04-02 09:44
Split worker.py into worker/ package. Entry point changed from 'python worker.py' to 'python -m worker'. collect_codesearchnet() stub removed; csn_samples=[] inlined in main.py. Dead code (_kill_descendants) removed. All behavior preserved.

## 2026-04-04 19:11
Single-process multi-thread model: one python -m worker per machine spawns N=os.cpu_count() threads. Machine registration happens once in main process (sends all_node_ids[] so coordinator sets node_stats for every thread). node_id flows as a parameter to all functions (no module-level NODE_ID). Non-daemon threads + SIGTERM→os._exit(0). python-concurrency-performance skill confirmed threading.Thread is correct for this sync I/O+CPU workload.

## 2026-04-04 19:26
Removed START_NODE_ID: all workers start node_ids from 1 (range 1..N). NODE_NAME moved to .env — required field, raises KeyError if missing. .env loaded in config.py at module load (before sentry_sdk.init); existing env vars take precedence so manual overrides still work.

## 2026-04-06 14:52
Phase 1 (query-based GitHub discovery) removed. Repos pre-seeded from repos_found.txt; worker goes straight to phase 2 (clone).

## 2026-04-06 15:05
Phase numbering in worker aligned to coordinator: 1=github/repos, 2=stack, 3=merge. Worker was using 2,3,4 (shifted by 1).

## 2026-04-06 16:56
THE_STACK_LANGUAGES stored as frozenset[str] (lowercased) in config.py; defaults to 'typescript' if not set — zero-config for existing deployments

## 2026-04-12 07:29
Workers must NOT send coord_quit() at all — coordinator must never be terminated by worker signals. Removed all coord_quit() calls from merge.py (4 call sites + import). coord_quit() function remains in coordinator.py but is no longer called.

## 2026-04-12 10:50
SIGINT segfault fix: daemon threads (not os._exit) because pyarrow C++ sigaction overrides Python signal.signal(). Daemon threads = no thread-join block on shutdown = KeyboardInterrupt exits cleanly.

## 2026-04-12 10:56
CTRL+C exit strategy: os._exit(0) in except KeyboardInterrupt block (not sys.exit, not signal.signal). sys.exit runs C++ destructors → segfault. signal.signal is overridden by pyarrow C++ sigaction → never called. os._exit from except block is the only clean path.

## 2026-04-12 10:59
pyarrow C++ sigaction fires at import time, not at first Dataset use. Fix: defer 'from datasets import Dataset', 'from worker.collectors.merge import ...', and 'from worker.collectors.stack import collect_the_stack' to inside phase functions. Top-level imports in main.py are now pyarrow-free.

## 2026-04-12 11:04
Ctrl+C exit strategy (final): sys.excepthook suppression, no try/except. Catching KeyboardInterrupt in Python 3.14 triggers C++ cleanup during exception unwinding → segfault. Natural propagation (uncaught KeyboardInterrupt) avoids that code path. sys.excepthook hides the traceback cleanly. Deferred datasets imports are kept to avoid pyarrow C++ sigaction override at startup.

## 2026-04-12 11:10
Ctrl+C attempt 5: signal.signal(SIGINT, SIG_DFL) at top of __main__.py before any imports. Resets SIGINT to OS default (terminate) before Python or C++ can override it. Ctrl+C -> process dies at OS level with exit code 130. No Python exception unwinding, no C++ destructors, no segfault, no traceback.
