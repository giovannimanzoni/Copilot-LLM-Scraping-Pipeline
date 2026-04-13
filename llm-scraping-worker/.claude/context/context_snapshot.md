=== Saved Context ===
  current_task: DONE: Fix idle loops missing heartbeats in merge.py (4 loops) and main.py (1 loop)  (saved: 2026-04-13T11:59:30.325225)
  next_task: none  (saved: 2026-04-13T11:59:30.650886)

=== decisions.md ===

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

=== progress.md ===

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
