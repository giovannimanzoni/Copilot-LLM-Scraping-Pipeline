=== Saved Context ===
  current_task: DONE: Final Check done.  (saved: 2026-04-13T12:15:25.724295)
  next_task: none  (saved: 2026-04-13T12:15:25.924941)

=== decisions.md ===

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

=== progress.md ===

## 2026-04-12 08:12
Removed coordinator self-termination claim from 3 places: merge.mts line comment, llm-scraping-worker/README.md line 176, llm-scraping-worker/CLAUDE.md Non-Obvious Constraints. Coordinator never exits on its own; it only sets fleet:state=done.

## 2026-04-12 10:31
Disabled merge-shared-fs-chk and merge-target-node-sel after phase 3 done (_mergePhaseDone=true when _fleetPhase>=4). dashboard.js v=15

## 2026-04-12 10:34
Fixed bug: isDisabledForPhase now takes priority over isDead/isBusy in worker card class and badge logic (dashboard.js). Workers not used in phase2 now show DISABLED instead of DEAD. dashboard.js v=16

## 2026-04-12 10:38
Removed dead {queries}:pending and {queries}:done sections from Redis dashboard (redis-dashboard.html, redis-dashboard.js, status.mts getRedisData, redis-keys.mts). Also removed 'queries' column from the node stats table. Keys never populated since repos are now loaded from repos_found.txt.

## 2026-04-12 10:43
Removed machine-specific badge classes (badge-n97, badge-pcgio, badge-big) and getNodeInfo() from dashboard. All workers now show unified badge-run (blue) in RUN state. dashboard.js v=17.

## 2026-04-13 09:16
Disabled merge-enabled-chk (phase 3 checkbox) when _mergePhaseDone in applyPhaseCheckboxDisabled(); also guarded chk.checked update to not override when phase done. dashboard.js v=18

## 2026-04-13 09:20
Fixed: POST /reset/phase/merge and POST /reset/all both now delete K.merge_transfer ('merge:transfer' HASH). Previously, post-merge transfer progress bars persisted after reset because the key was not included in the delete list.

## 2026-04-13 12:15
DONE: Final Check done.
