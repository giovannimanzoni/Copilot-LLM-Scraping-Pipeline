
## 2026-03-29 23:47
Created /redis dashboard (src/redis-dashboard.html) + /redis/data endpoint + /redis/events SSE in coordinator.mts. Shows all Redis keys with counts, assigned repos/stack tasks with ages, query lists as chips, node heartbeat TTLs, full node stats table. Refreshes every 5s.

## 2026-03-29 23:49
Added shared nav menu (overview / redis) to dashboard.html and redis-dashboard.html. Active link highlighted in page accent color (teal for overview, red for redis).

## 2026-03-29 23:55
Added /reset dashboard (src/reset-dashboard.html) + POST /reset/all and POST /reset/problematic endpoints. Reset all wipes all keys and re-seeds. Reset problematic re-queues problematic stack tasks. Confirmation modal dialogs on both. Updated nav in dashboard.html and redis-dashboard.html.

## 2026-03-30 00:16
Added POST /reset/stack endpoint in coordinator.mts + 'reset stack' card/modal/JS in reset-dashboard.html. Wipes all stack keys and re-seeds with current TOTAL_WORKERS. Repos/queries/worker stats untouched.

## 2026-03-30 00:32
Refactored stack task distribution: from TOTAL_WORKERS static shards (node_id/total_nodes) to STACK_BATCH_COUNT dynamic batches (batch_index/total_batches). Any free worker can pick any batch. Added STACK_BATCH_COUNT env var (default 100). Updated /stack/next (no more nodeId loop), /stack/done schema, /reset/all, /reset/stack, getStatusData (total_batches field). Dashboard phase 3 now shows batch counter (done/total) and % progress.

## 2026-03-30 14:37
Created README.md with full project docs (architecture, API, config, VCS). Rewrote CLAUDE.md to contain only Claude CLI essentials: session protocols, commands, VCS note, gotchas, env vars. Node version corrected to 24.14.1.

## 2026-03-30 14:49
Fixed instrument.mts DSN→SENTRY_DSN. Corrected README: query count now generic (no hardcoded number), added /redis/data and /redis/events to API table, added dead-worker watchdog to docs, fixed env vars DSN→SENTRY_DSN+SENTRY_ENVIRONMENT. Updated CLAUDE.md env list to match.

## 2026-03-31 20:00
Fixed dashboard.html line 1144-1148: phase completion log color was red (misleading), now green with message 'click start phase N'. Manual stop still logs red. Button logic was already correct.

## 2026-03-31 20:07
coordinator.mts: extracted isPhaseComplete() helper; refactored phase-watcher to use it; /fleet/phase/stop now checks if work is done and advances fleet_phase if so — button immediately shows START PHASE 2. dashboard.html: phase completion log color changed from red to green.

## 2026-03-31 20:16
coordinator.mts isPhaseComplete(1): removed stack_assigned=0 requirement. Root cause: tasks linger in stack_assigned for 45min timeout, blocking phase completion detection. Fix: sp===0 && sd>0 is sufficient.

## 2026-03-31 20:20
isPhaseComplete(1) fix round 2: added stack_problematic check. When all tasks time out they go to stack_problematic not stack_done, so sd>0 was always false. Now: sp===0 && (sd>0||spr>0).

## 2026-03-31 20:24
isPhaseComplete(1) fix round 3: sp===0 && (sa+sd+spr>0). Root cause: all tasks in stack_assigned, nothing in done/problematic yet. Previous check still returned false. New check: if all tasks distributed (sp=0) and at least one started (sa+sd+spr>0), phase is complete.

## 2026-03-31 20:53
isPhaseComplete(1) final fix: sp===0 only. All previous conditions (sa=0, sd>0, spr>0) were failing in different data states. sp=0 is the only guaranteed signal that phase 1 work has been fully distributed.

## 2026-03-31 20:56
ROOT BUG FOUND AND FIXED: isPhaseComplete had phases in wrong order. Phase 1 must check queries (not stack), phase 2 must check repos, phase 3 must check stack.

## 2026-03-31 21:00
Fixed /reset/all: now also resets fleet_phase=0 and fleet_state=stopped so dashboard shows correct initial state after full reset.

## 2026-03-31 21:57
Added POST /worker/register and POST /reset/worker_names routes. Dashboard uses n.node_name for badge label. Reset page has 'reset worker names' card with modal.

## 2026-03-31 22:07
Doubled activity log max-height from 100px to 200px to match phase1+phase2 boxes height in dashboard.html

## 2026-03-31 22:11
Changed running worker badge label from displayName to 'RUN' in dashboard.html:965

## 2026-04-01 09:19
Added fleet_github_enabled and fleet_stack_enabled Redis flags, two new POST endpoints, SSE data fields, and two checkboxes in dashboard UI. Disabled phases count as complete in isPhaseComplete, allowing pipeline to skip them. Next: none

## 2026-04-01 09:23
Fixed fleet/phase/start to skip to phase 3 when github disabled, return 400 when both disabled. Updated updatePhaseBtn to show correct start phase label and amber warning when both phases disabled. Next: none

## 2026-04-01 10:59
Progress items get progress-item--disabled class (hides bar+stats, dims box, strikethrough title) when github/stack enabled flags are off. Applied immediately on checkbox change and on SSE sync. Next: none

## 2026-04-01 11:11
Fixed workers receiving tasks when phase is disabled: /queries/next, /repos/next, /stack/next now return null immediately when the corresponding enabled flag is off. Workers break out of their loops on null. Next: none

## 2026-04-01 11:57
Added applyPhaseCheckboxDisabled(): disables github-enabled-chk when fleet_phase >= 3. Called on every SSE phase update. Next: none

## 2026-04-01 11:59
Changed phase1+2 checkbox disable logic from fleet_phase>=3 to actual phase 2 completion (repos pending=0, assigned=0, done>0). Tracked via _phase2Complete, updated from SSE github data. Next: none

## 2026-04-01 22:52
DONE: shard-based batching implemented (coordinator + worker). fetchHFDatasetFiles + seedStackTasks in coordinator.mts; conditional shard/strided load in worker.py. Zero-loss stop guaranteed: workers complete shard (<1 min) then block at wait_for_phase(3). Next: none.

## 2026-04-01 23:13
DONE: removed strided fallback from seedStackTasks() — coordinator now fails fast if HF API unreachable. Removed STACK_BATCH_COUNT constant entirely. Worker retains data_files/data_dir branch for backward compat with old Redis tasks.

## 2026-04-02 13:16
Completed full coordinator refactor: split 1140-line coordinator.mts into 17 TS modules + 6 static CSS/JS files. TypeScript: 0 errors, ESLint: 0 errors (7 pre-existing any warnings). Architecture: config, redis-keys, validate, stack-seeder, watchdog, init, status, routes/*, app, coordinator entry point. HTML dashboards now reference external CSS/JS via /static/*.

## 2026-04-02 15:42
Fixed isPhaseComplete(3) in watchdog.mts: added sa === 0 check so phase 3 only completes when all assigned tasks are done, matching phases 1/2 behavior.

## 2026-04-02 15:48
Updated coordinator README.md: fixed phase 3 description (the-stack not StackOverflow), added HF_TOKEN env var, added /worker/register endpoint, expanded fleet control and reset API tables. Updated coordinator CLAUDE.md: added Codebase file structure, Key Modules table, Non-Obvious Constraints section. Worker README.md and CLAUDE.md were already comprehensive and needed no changes.

## 2026-04-02 16:23
Added phase 4 (dataset merge): new merge route in coordinator, fleet_merge_enabled flag, watchdog updated for phase 4, dashboard checkbox + progress bar, worker merge.py collector, main.py phase 4 handling

## 2026-04-02 17:31
Extended phase 4: shared-FS checkbox (one global merge vs per-machine), merge node dropdown (random or specific NODE_NAME), per-machine merge status display in dashboard, registered_node_names SET tracks all machines

## 2026-04-02 21:39
Bug fix: worker no longer overwrites per-node dataset when collection is disabled (merge-only runs are now safe)

## 2026-04-02 21:53
Updated both READMEs: coordinator README adds phase 4 section, new API endpoints (merge, fleet merge settings), updated watchdog/architecture; worker README adds phase 4 flow, merge logic, merge-only run behaviour, final_dataset output path

## 2026-04-02 22:27
DONE: Added fleet:phase_error Redis key. When auto-advance is ON and a phase completes with errors (phase 3: stack_problematic > 0), watchdog sets fleet_state=stopped + fleet:phase_error=1 instead of advancing. Flag is returned in /fleet/state, /status (SSE). Cleared on: fleet/phase/start, reset/all, reset/stack, reset/phase/stack, reset/phase/queries, reset/phase/repos, reset/problematic. Dashboard shows red banner + activity log entry. Files changed: redis-keys.mts, watchdog.mts, status.mts, routes/fleet.mts, routes/reset.mts, dashboard.html, static/dashboard.js

## 2026-04-02 22:30
DONE: Updated coordinator README.md (What it does, Watchdog section, Fleet state section, /fleet/state table row) and CLAUDE.md (Key Modules table, Non-Obvious Constraints) to document fleet:phase_error and the auto-advance error-halt behavior.

## 2026-04-04 07:15
Added accordion toggle to phase 1-4 progress boxes on dashboard: click header to collapse/expand, chevron indicator rotates, disabled phases remain unclickable

## 2026-04-04 08:48
Made dashboard overview section fixed (flex-shrink:0) and workers section scrollable (flex:1, overflow-y:auto). Body/html set to height:100%/overflow:hidden, main is flex column.

## 2026-04-04 09:34
Added per-shard merge progress: new /merge/progress API, 3 new Redis keys, shard bar in phase 4 box (shared+per-machine), activity log entries on shard load

## 2026-04-04 09:48
Fixed: moved merge-shard-bar-section outside shared-FS display block — shard bar now always visible when merge is running, regardless of shared filesystem setting

## 2026-04-04 09:53
Fixed shard bar visibility: removed display:none from HTML and totalShards>0 guard in JS — bar always renders, shows 0/? when no merge data yet

## 2026-04-04 11:34
DONE: Phase 4 merge race condition fix. New key merge:ready_node_ids (SET of node_id strings). New endpoint POST /node/merge_ready. GET /merge/next now checks all peer node_ids on same machine are ready before assigning. merge_ready_node_ids cleared in /reset/all.

## 2026-04-04 11:40
DONE: Updated coordinator README.md — added /node/merge_ready to API table, merge:ready_node_ids to Redis keys section, and readiness gate explanation in Phase 4 section.

## 2026-04-04 11:44
Fixed: reset/all was missing merge keys (merge_status, merge_assigned_node, merge_assigned_nodes, merge_done_nodes, merge_node_samples, merge_shards_loaded, merge_shards_total, merge_last_shard). Added /reset/phase/merge route. Added phase 4 card, modal, and JS handler to reset dashboard UI. Next: none

## 2026-04-04 11:55
Fixed phase 4 merge bug: merge:assigned_nodes persisted across runs causing all workers to see 'another worker is handling merge'. Now cleared on phase 4 entry in both watchdog auto-advance and manual fleet/phase/start paths.

## 2026-04-04 13:33
Fixed: /reset/all now clears registered:node_names so phase4 machines no longer appear in machines list after reset

## 2026-04-04 13:37
Added Phase x: completed. log to watchdog.mts when isPhaseComplete triggers; added Phase x: waiting to start to watchdog.mts (non-auto-advance branch) and coordinator.py wait_for_phase (first iteration only). Both projects pass lint/typecheck.

## 2026-04-04 13:41
Fixed dashboard.js updatePhaseBtn: removed disabled state when phase>=5, now shows start phase 4 button so user can restart phases after all complete

## 2026-04-04 14:02
Fixed worker badge in dashboard.js: replaced isIdle/isWorkerIdle (based on worker_status field) with phase-aware logic. isWorkerDone = alive + no active work + fleet phase > lastEnabledPhase. isWorkerIdle = alive + no active work + NOT all phases done. DONE badge only when fleet has advanced past all enabled phases. IDLE badge when worker has no active work but more phases remain.

## 2026-04-04 14:10
Added dark/light mode toggle to all 3 dashboards (dashboard, redis, reset). Lightened dark mode from #0d0d0d→#18181b. Created static/theme.js (shared, localStorage persistence, no-flash). Full light mode CSS variables + component overrides in all 3 CSS files.

## 2026-04-04 14:12
Fixed: theme toggle button had no route. Added /static/theme.js route to dashboard.mts. Toggle now works across all 3 dashboards.

## 2026-04-04 14:17
Softened light mode: shifted from near-white (#f8fafc/#ffffff) to slate-gray (#d1d5db/#e5e7eb). All three CSS files updated. Accent dim colors also darkened to match (e.g. green-dim #dcfce7→#bbf7d0, red-dim #fee2e2→#fecaca).

## 2026-04-04 14:22
Refactored common CSS: created static/common.css with shared variables, reset, header, nav, status-dot, theme-toggle. Each dashboard CSS imports it and overrides --accent (teal/red/amber). Added /static/common.css route in dashboard.mts. All 3 dashboards unchanged visually.

## 2026-04-04 14:24
Filtered workers grid to registered workers only: loop now iterates registeredIds (nodes with node_name set); stale cards are removed on each update. No backend changes needed.

## 2026-04-04 18:12
DONE: post-merge orchestration. Added ZIP_AND_UPLOAD (/merge/upload_partial/:nodeName, /merge/upload_final), Final Merger claim (/merge/claim_final), partials polling (/merge/partials_status), download (/merge/download_partial/:nodeName), QUIT (/merge/quit with auto-SIGTERM when all machines done). 3 new Redis keys. Phase-4 clear and resets updated.

## 2026-04-04 18:38
DONE: documented post-merge orchestration in coordinator README (API table, Phase 4 section, Redis keys), worker README (Phase 4 section with post-merge decision tree and partials flow), and worker CLAUDE.md (coordinator API table + non-obvious constraints). Next: none

## 2026-04-04 19:11
DONE: extended /worker/register to accept optional all_node_ids[]. When provided, coordinator sets node_stats.node_name for all thread node_ids in one request. Falls back to [node_id] when omitted (backward compat). Next: none.

## 2026-04-04 19:36
DONE: removed TOTAL_WORKERS from all coordinator files. Added registered:node_ids Redis SET (populated on /worker/register). All loops that iterated 0..TOTAL_WORKERS now fetch registered node IDs dynamically from Redis. reset/all clears registered_node_ids. CLAUDE.md and reset-dashboard.html updated. Next: none.

## 2026-04-05 07:54
DONE: documentation updated for NODE_NAME/NODE_HASH. Coordinator README: removed TOTAL_WORKERS, updated Worker model section (hash, crash recovery), updated /worker/register API row. Worker README: env table updated (NODE_NAME required max 8 ASCII, NODE_HASH required exactly 8 ASCII, removed NODE_ID, added THREADS, added crash-recovery note), updated debug run example. Worker CLAUDE.md: added /worker/register to coordinator API table. Next: none

## 2026-04-05 08:28
DONE: Phase button UX overhaul — after a phase completes (fleet stops, phase>0), button shows 'select a phase to run' (disabled). Clicking a phase progress item selects it (green highlight), button updates to 'start phase X'. Starting clears selection. Backend: added POST /fleet/phase/set. Last selected phase wins (click 4 then 3 → shows 3). Next: none

## 2026-04-05 08:37
DONE: fixed watchdog auto-advance bug — when only phase 1+2 enabled and auto-advance on, after phase 2 completes the watchdog was setting fleet_state=running for disabled phases 3 and 4 (because isPhaseComplete returns true immediately for disabled phases). Fix: in the auto-advance no-errors path, scan forward skipping disabled phases to find the first actually-runnable phase; set fleet_phase to that (or 5 if all done) and set fleet_state=stopped if nothing to run. Next: none

## 2026-04-05 08:46
DONE: fixed watchdog auto-advance — added isPhaseEnabled(phase) helper; when auto-advance is on and nextPhase is disabled, set fleet_state=stopped instead of running it. Previous fix (scan-forward to skip) was wrong because it advanced fleet_phase to 5. Correct fix: stop at the first disabled phase, let the user decide. Next: none

## 2026-04-05 08:53
DONE: fixed watchdog auto-advance disabled-phase bug. Two wrong fixes before: (1) scan-forward to skip disabled phases → jumped to phase 5. (2) stop at nextPhase even if disabled → still advanced fleet_phase to 3, workers exit. Correct fix: when nextPhase is disabled, keep fleet_phase=phase, only set state=stopped. Workers idle via wait_for_phase. No worker changes needed. Next: none

## 2026-04-05 16:00
DONE: three-iteration fix for auto-advance disabled-phase behavior. Final solution: coordinator sets fleet_phase=nextPhase+state=stopped when nextPhase disabled. Worker checks both fleet_phase AND fleet_state before exiting repo loop — waits (sleep 15s) when stopped, exits when running. No changes to wait_for_phase needed. Next: none

## 2026-04-05 16:09
DONE: removed 'select a phase to run' disabled state from phase button. Button now always shows the first enabled phase as default (github→1, stack→3, merge→4). Clicking a phase item still overrides the selection. This fixes the stuck state after phase 1+2 complete with 3+4 disabled.

## 2026-04-05 16:14
DONE: fixed togglePhase — disabled phase items (3+4) now selectable when fleet is stopped. Removed early return on progress-item--disabled; only the collapse toggle is skipped for disabled items. Selection logic still runs. updatePhaseBtn reverted to original 'select a phase to run' disabled state.

## 2026-04-05 16:24
DONE: togglePhase — removed _fleetPhase > 0 guard, selection now works whenever fleet is stopped regardless of phase value. Added Cache-Control: no-store to all JS static endpoints in dashboard.mts to prevent browser caching issues. Coordinator restart needed for cache header change; JS fix is immediate.

## 2026-04-05 16:31
DONE: removed btn.disabled=true from 'select a phase to run' case — button is always enabled when stopped and phases exist. handlePhaseBtn now auto-picks first enabled phase when _selectedPhase is null. Added ?v=2 to dashboard.js script tag to force browser cache bust on next page load.

## 2026-04-05 16:34
DONE: added console.log to togglePhase (logs item id, isDisabled, state, phase, selected) and SSE reset handler (logs when/why _selectedPhase is nulled). Button behavior reverted to correct: disabled when nothing selected. ?v=3 to force cache bust.

## 2026-04-05 16:39
DONE: root cause found — user was clicking phase enable/disable checkboxes (stack_enabled, merge_enabled), NOT the phase item headers. togglePhase was never called. Fix: setStackEnabled/setMergeEnabled/setGithubEnabled now auto-select the corresponding phase when enabled while fleet is stopped+phase>0, and clear selection when disabled. Removed debug console.logs.

## 2026-04-05 17:03
DONE: (1) Coordinator no longer self-terminates after merge/quit — stays alive for download. (2) Added GET /merge/download_final endpoint. (3) Dashboard shows download button when merge_final_uploaded=1. (4) Button shows all phases complete when phase>=5. (5) Worker suppresses resource_tracker UserWarning via PYTHONWARNINGS env var in config.py. (6) Added merge_final_uploaded Redis key; cleared on reset.

## 2026-04-05 22:36
DONE: repos_problematic mechanic — /repos/fail now routes to repos_problematic set; isPhaseComplete(2) includes problematic; watchdog stops at phase 2 (no advance) when errors; /reset/repos_problematic re-queues + clears repos_failed stats; dashboard shows RETRY PROBLEMATIC button (amber) when phase=2+stopped+phaseError+reposProblematic>0; click re-queues repos and starts phase 2.

## 2026-04-05 23:33
DONE: watchdog phase skip fix — when nextPhase is disabled, now loops forward to find first enabled phase and starts it (instead of stopping). Phase 2→4 with phase 3 disabled now works correctly.

## 2026-04-05 23:58
DONE: POST /reset/all now deletes data/partials/ (rm -rf) and data/final_dataset.zip before re-seeding. Uses node:fs/promises rm with force:true so it is safe to call even when the folder/file doesn't exist yet. Next: none

## 2026-04-06 09:13
DONE: phase-watcher setInterval changed from 5_000ms to 10*60_000ms (10 minutes). Next: none

## 2026-04-06 09:16
DONE: phase-watcher interval stays 5s; added lastClusterDownSentryTs guard — CLUSTERDOWN only reported to Sentry once per 10 minutes. Non-CLUSTERDOWN errors still reported immediately. Next: none

## 2026-04-06 09:30
DONE: when phase 1 completes, watchdog writes all repos_pending members to data/repos_found.txt (one per line). writeReposFoundFile() called in phase-watcher interval before auto-advance logic. Next: none

## 2026-04-06 09:48
DONE: phase 1 file write failure is now a blocking error. New Redis keys: fleet:repos_file_error, fleet:repos_file_written. New route POST /fleet/retry_repos_file. Dashboard button shows 'retry write repos file' (amber). reset/all and reset/phase/queries clear both flags. Next: none

## 2026-04-06 09:57
DONE: GITHUB_QUERIES loaded from src/.github_queries.yaml using yaml package. Null YAML entries (comment-only lines like '- # section') filtered out. Added yaml dependency. config.mts reads file at startup via process.cwd(). Next: none

## 2026-04-06 09:59
DONE: .github_queries.yaml moved to coordinator root (was already there). Path in config.mts was already correct (.github_queries.yaml without src/ prefix). Updated CLAUDE.md to document the file in the codebase layout. Next: none

## 2026-04-06 09:59
DONE: README.md updated — phase 1 description and queries architecture section now reference .github_queries.yaml. Next: none

## 2026-04-06 10:01
DONE: fixed TypeError: Cannot read properties of undefined 'filter' in config.mts. YAML root is a list (- queries:), so parsed is an array — changed cast and access to parsed[0].queries. Next: none

## 2026-04-06 10:06
DONE: POST /reset/all no longer deletes queries_pending/queries_done or re-seeds queries. reset/phase/queries still handles query reset. Next: none

## 2026-04-06 10:09
DONE: reset/all now clears queries_pending and queries_done (so dashboard shows 0) but does not re-seed from YAML. reset/phase/queries still re-seeds. Next: none

## 2026-04-06 10:14
DONE: replaced npx tsc/eslint/tsx with node_modules/.bin/* calls in all package.json scripts to fix npm v11 Unknown env config warnings caused by Yarn 1.x injecting npm_config_* env vars. Next: none

## 2026-04-06 10:29
DONE: /queries-gen utility page. New files: src/routes/utility.mts (POST /utility/github-queries), src/queries-generator.html, src/static/queries-generator.{css,js}. Route registered in app.mts, static+page routes in dashboard.mts. Nav link added to all 3 existing dashboards. Uses GITHUB_TOKEN env var if set, else unauthenticated. Fetches 2 pages (200 repos), extracts topics, groups into 8 categories, outputs YAML. Next: none

## 2026-04-06 10:58
DONE: /queries-gen now streams progress via SSE (GET /utility/github-queries/stream). Log area appears below form while fetching; emits one log line per GitHub page + final result event. Frontend switched from fetch POST to EventSource. Also fixed copy button to use textarea fallback for LAN (non-HTTPS) access. Next: none

## 2026-04-06 11:00
DONE: documentation updated. README.md: added GITHUB_TOKEN to config table, query generator note in Queries architecture section, new Dashboards & utilities table with /queries-gen and full SSE endpoint spec (params, event types, rate limit notes). CLAUDE.md: updated router count (7→8), added utility.mts and queries-generator.html to codebase layout. Next: none

## 2026-04-06 11:02
DONE: fixed TypeError in config.mts when .github_queries.yaml is empty — parseYaml returns null for empty files, added null guard + warning log. Also restored .github_queries.yaml which had been wiped. Next: none

## 2026-04-06 11:11
DONE: fixed Redis 'wrong number of arguments for sadd' crash when .github_queries.yaml is empty. Guarded sAdd call in init.mts and routes/reset.mts. Next: none

## 2026-04-06 11:16
DONE: /utility/github-queries/stream now uses recursive bisection on star ranges (minStars..1_000_000) to bypass GitHub's 1000-result cap. Each sub-range is probed first; if >1000 repos it bisects at midpoint, recurses. Rate limit (403/429) auto-waits using X-RateLimit-Reset header. Next: none

## 2026-04-06 11:21
DONE: star ceiling is now dynamic — initial probe uses sort=stars&order=desc&per_page=1 to read the top repo's stargazers_count, used as upper bound for bisection. No repos missed, no arbitrary ceiling. Next: none

## 2026-04-06 11:26
DONE: fixed EventSource disconnect during GitHub rate limit wait. Two fixes: 1) keepalive setInterval writes ': keepalive' SSE comment every 15s to prevent proxy/browser timeout; 2) rateLimitWait() replaces single sleep — emits countdown log every 5s so data keeps flowing. Next: none

## 2026-04-06 13:51
Completed: full removal of Phase 1 (queries), phase renumbering (repos=1, stack=2, merge=3), /repos/batch/:nodeId returning 100 repos via SPOP count, coordinator process.exit(1) on missing repos_found.txt, reset/all and reset/phase/repos re-seed from repos_found.txt. All TypeScript errors fixed, 0 lint errors.

## 2026-04-06 14:09
Completed: utility.mts → repo scanner (writes data/repos_found.txt via /utility/repo-scanner/stream), updated queries-generator UI, init.mts now warns instead of process.exit(1) when repos_found.txt missing. 0 TypeScript errors, 0 lint errors.

## 2026-04-06 14:49
Added queries.mts (POST /queries/next returns {query:null} — no-op since repos pre-seeded) and GET /repos/next/:nodeId (single-pop variant) to fix worker 404 crashes. Registered queriesRouter in app.mts.

## 2026-04-06 14:52
Removed dead phase 1: deleted queries.mts, removed queriesRouter from app.mts, removed phase 1 loop + github_search_repos from worker/collectors/github.py, dropped unused requests/GITHUB_HEADERS imports.

## 2026-04-06 16:44
Wrapped merge-model-section (shared-fs + merge-node controls) in a div that shows only when phase 3 checkbox is enabled. Toggled in setMergeEnabled() and SSE sync block.

## 2026-04-06 17:06
Removed all .github_queries.yaml references from coordinator documentation (README.md, CLAUDE.md)

## 2026-04-06 17:12
Docs updated: removed GitHub queries phase, documented data/repos_found.txt seeding, 3-phase structure (Repos/Stack/Merge), new Repo Scanner utility, updated HTTP API and reset tables

## 2026-04-06 17:26
Changed repos_found.txt path from data/ to input_data/ across all code (utility.mts, reset.mts, init.mts) and docs (README.md, CLAUDE.md, queries-generator.html, reset-dashboard.html). Type check and lint clean.

## 2026-04-06 18:13
Added THE_STACK_LANGUAGES to config.mts, GET /config endpoint in worker.mts; worker: removed env var from config.py, fetch_stack_languages() in coordinator.py, stack_languages param threaded through main.py → _run_worker → collect_the_stack()

## 2026-04-06 18:14
Updated READMEs: removed THE_STACK_LANGUAGES from worker README, added it to coordinator README config table

## 2026-04-06 18:21
Added POST /reset/fleet_settings endpoint + reset card + modal + JS handler to reset all dashboard checkboxes (auto_advance, repos/stack/merge_enabled, merge_shared_fs, merge_target_node) to defaults. Type check + lint clean.

## 2026-04-06 18:23
Fleet settings (auto_advance, repos/stack/merge_enabled, merge_shared_fs, merge_target_node) now reset to defaults inside existing POST /reset/all. No new button or modal added.

## 2026-04-06 18:26
POST /reset/all now sets all fleet checkbox keys to 0 (unchecked): auto_advance, repos_enabled, stack_enabled, merge_enabled, merge_shared_fs, and deletes merge_target_node.

## 2026-04-06 22:15
Added BUSY intermediate worker state to both dashboards. Was: dead after 2min. Now: busy after 2min, dead after 20min. Changed: dashboard.js, redis-dashboard.js, dashboard.css, redis-dashboard.css, watchdog.mts (Sentry alert 5min→20min)

## 2026-04-06 22:28
Fixed: phase-error banner not hiding when retrying problematic repos. Root cause: handlePhaseBtn set _phaseError=false locally but didn't update the DOM; SSE state-change detection skipped because _fleetState was already updated to 'running' before SSE arrived. Fix: added banner.style.display='none' directly in the retry branch of handlePhaseBtn (dashboard.js).

## 2026-04-06 22:37
Implemented sequential retry for problematic repos: added repos_retry_queue/retry_active Redis keys, advanceRetryQueue helper in repos.mts, hooked done/fail handlers, fixed isPhaseComplete in watchdog, added cleanup to full/phase resets, added dashboard button+modal+JS

## 2026-04-06 23:16
Added repos_cancelled Redis key. Not-found repos route to cancelled (not problematic), excluded from retry reset, shown in phase 1 box. Fixed reposTotal to include problematic+cancelled for accurate %. Type check clean.

## 2026-04-06 23:41
Moved repos_failed hIncrBy inside the else branch in /repos/fail so cancelled (not-found) repos are not counted as failed in node stats / redis dashboard

## 2026-04-06 23:44
Added repos_cancelled to getRedisData(), redis-dashboard.html (section after done), redis-dashboard.js (keyDefs card + chip rendering)

## 2026-04-07 14:18
Added full repo lists to redis dashboard: {repos}:assigned (all entries, was capped at 99) and {repos}:pending (all members, was sampled 50) — both wrapped in 200px scrollable divs

## 2026-04-07 14:25
Fixed redis dashboard crash: queries_pending+queries_done were missing from getRedisData() and redis-keys.mts (removed in past commit but JS still referenced them). Restored both. Also: repos:assigned now fetches all entries (was capped 99), repos:pending fetches all members (was sampled 50), both sections have 200px scrollable div.

## 2026-04-07 14:36
Fixed redis-dashboard.js: both node loops now iterate over actual node IDs (Object.keys(nodes)) instead of 0..total_workers-1. Names now show NODE_NAME (worker-XX) format matching the dashboard page.

## 2026-04-07 14:39
Added max-height:200px scroll to {stack}:pending section in redis-dashboard.html

## 2026-04-07 14:43
Changed lRange(stack_pending, 0, 19) → lRange(0, -1) in status.mts; updated refresh-note label from 'first 20 items' to 'all items' in redis-dashboard.html; max-height:200px was already in place

## 2026-04-07 14:46
Moved reset nav tab after repo scanner in dashboard.html, redis-dashboard.html, queries-generator.html, reset-dashboard.html

## 2026-04-08 11:03
Added _stackPhaseDone detection: when stack data shows done (pending=0, assigned=0, done>0), auto-uncheck + disable phase 2 checkbox and POST stack_enabled=false to backend. Watchdog already handles skipping disabled phases during auto-advance. Fixed togglePhase to not select disabled phases. Also guarded fleet_stack_enabled SSE sync to avoid race condition re-enabling the checkbox.

## 2026-04-09 10:39
Filtered dashboard workers grid: added last_heartbeat > 0 check so only workers active in current phase appear (dashboard.js line 234)

## 2026-04-09 10:44
Workers grid: neverSeen workers now show DISABLED badge + worker-disabled dimmed card style instead of unseen dash

## 2026-04-09 10:48
Phase pills in worker cards now show phase-disabled (strikethrough) when phase 1/2 checkbox is unchecked; setGithubEnabled/setStackEnabled call _origUpdate(prevData) to re-render immediately

## 2026-04-09 10:54
Per-phase registration: worker sends n_phase1/n_phase2 → coordinator stores in registered:phase1_threads/phase2_threads → status.mts exposes to SSE → dashboard.js uses isWorkerActiveInPhase() for DISABLED badge logic

## 2026-04-09 11:17
Fixed isDisabledForPhase: when fleet running→disabled if not in current phase; when stopped/not started→disabled if not in any enabled phase (respects checkboxes)

## 2026-04-09 18:36
Fixed setMergeEnabled: removed auto-select of _selectedPhase=3 on enable — was causing green background on phase3 progress box. Kept deselect-on-disable logic intact.

## 2026-04-09 18:40
Fixed phase3 page reload: (1) merge-model-section now shown unconditionally when fleet_merge_enabled=true (was only on change → defaulted to hidden); (2) sel.value now set when fleet_merge_target_node arrives (was only set in registered_node_names block → race condition)

## 2026-04-10 20:18
Fixed setMergeEnabled: added _selectedPhase=3 on enable when fleet stopped (was only clearing on disable). Matches setGithubEnabled/setStackEnabled pattern. File: src/static/dashboard.js

## 2026-04-10 20:23
Fixed updatePhaseBtn: added numEnabledPhases check — only show 'select a phase to run' when >1 phase enabled. When only phase 3 is enabled (1&2 done), button auto-shows '▶ start phase 3' on reload and on checkbox check, without setting _selectedPhase (no green background side-effect). Reverted bad setMergeEnabled auto-select from previous turn.

## 2026-04-10 20:25
Fixed updatePhaseBtn: 'select a phase to run' now only shown when _fleetPhase is not an enabled phase (e.g. phase=3, mergeEnabled=true → directly shows '▶ start phase 3'). Previous numEnabledPhases fix was wrong — _githubEnabled/_stackEnabled stay true even when phases are done, so count was always 3.

## 2026-04-10 20:41
Fixed reset/phase/merge: added fleet_state=stopped, disk cleanup (data/partials/, data/final_dataset.zip). Now correctly restores merge to 'never started' state.

## 2026-04-10 20:43
Renamed data/ → data3/ for all phase 3 (merge) paths: output_dir sent to workers, partials upload/download, final dataset upload/download, and reset cleanup in reset/all and reset/phase/merge. data/typescript in config/stack-seeder left unchanged (HuggingFace dataset identifier).

## 2026-04-10 20:53
Frontend polish: section titles now have left teal accent + border-left, bar-track 4px→6px, metric cards have hover transition, log container 200→240px, header gets subtle gradient, status dot pulses when live, inline styles extracted to .phase-grid/.phase-btn-base/.phase-download-link CSS classes in dashboard.css, reset-card hover added. No functional changes.

## 2026-04-10 21:20
Added merge:save_pct Redis key; POST /merge/save_progress endpoint; status.mts includes save_pct; reset clears it. Dashboard: 'shards loaded' bar replaced with 'machines merged' (done_nodes/registered_node_names); new 'dataset save' bar (avg save_pct). Activity log logs at 10% boundaries.

## 2026-04-10 21:38
Fixed accordion arrow green background bug: added toggleCollapseOnly(event) that stops propagation so clicking the arrow only collapses/expands without triggering phase selection (progress-item--selected / green bg). All 3 phase headers updated in dashboard.html, function added to dashboard.js.

## 2026-04-10 22:30
Fixed reset/phase/merge: added await redis.set(K.fleet_phase, '3') so fleet_phase resets from 4→3. Without it, dashboard updatePhaseBtn hits phase>=4 branch ('all phases complete') when user enables merge checkbox after reset.

## 2026-04-11 06:36
Fixed phase 2 error retry: added _stackProblematic var, updated it from SSE stack data, added 'retry stack problematic' button branch in updatePhaseBtn() and handlePhaseBtn() in dashboard.js. On click: POST /reset/problematic → POST /fleet/phase/set {phase:2} → POST /fleet/phase/start. No backend changes needed.

## 2026-04-11 07:19
Added 'shards loading' progress bar to phase 3 merge section in dashboard.html + dashboard.js. Bar shows sum(shards_loaded)/sum(shards_total) across all machines. Placed above 'machines merged' bar.

## 2026-04-11 13:58
Fixed 3 merge-related bugs: (1) isPhaseComplete(3) non-shared-FS now checks merge_final_uploaded===1 (set when Final Merger uploads global result) instead of per-machine merge_done_nodes — prevents premature phase completion while global merge is still running; (2) clearMergeState() (watchdog auto-advance path) now clears same keys as fleet/phase/start: added merge_save_pct, merge_final_merger, merge_partial_uploads, merge_quit_node_names, merge_final_uploaded; (3) fleet/phase/start phase-3 clear list: added merge_save_pct and merge_final_uploaded

## 2026-04-11 15:26
Fixed green background on phase 2 box when checking 'phase 2 enabled' checkbox: removed _selectedPhase=2 auto-set from setStackEnabled (same for setGithubEnabled/_selectedPhase=1). Enabling a phase no longer selects it; only disabling still clears the selection. dashboard.js bumped to v=12.

## 2026-04-11 15:43
Added writeCancelledLog() in watchdog.mts: when phase 1 completes, reads all K.repos_cancelled members from Redis and appends each to data1/cancelled.log (one repo per line, dir created if missing). Called fire-and-forget right after phase completion is detected, before error/advance branching.

## 2026-04-11 15:54
Fixed SSE memory leak: /events and /redis/events switched from setInterval to recursive setTimeout; added res.on('error', cleanup) to clear timer on broken socket. Prevents concurrent push() calls from stacking large getStatusData()/getRedisData() result objects in memory.

## 2026-04-11 16:03
reset/phase/merge: added fleet_merge_enabled=0 and del fleet_merge_target_node so phase-3 checkbox is unchecked and merge node reverts to random after reset

## 2026-04-11 16:15
Fixed /merge/claim_final: when fleet_merge_target_node is set, only the designated node can claim Final Merger — all others are rejected before SETNX. No behaviour change when target is unset (random/first-wins).

## 2026-04-11 16:33
Added src/logger.mts with log/warn/error wrappers that format timestamps as YYYY-MM-DD HH:MM:SS,mmm [LEVEL][coordinator]. Replaced all console.log/warn/error calls across 10 source files. No new errors introduced.

## 2026-04-12 05:58
Fixed: Node.js 18+ server.requestTimeout defaults to 300s, causing 408 abort on 26.6 GB final upload (~5.5 min). Set server.requestTimeout=0 after app.listen() in coordinator.mts.

## 2026-04-12 06:22
Added Phase 3 transfer progress tracking: new merge:transfer Redis hash, POST /merge/transfer_progress endpoint, dashboard phase-3 box post-merge section with per-machine progress bars and stage labels, activity log entries for all stage transitions and 25/50/75% upload/download milestones. Worker reports: zipping, uploading_partial, uploading_final (with bytes progress via background thread), waiting_partials, downloading_partial (with bytes progress), extracting, integrating, shuffling stages. dashboard.js bumped to v=13.

## 2026-04-12 06:41
Worker box stack-finished layout: removed (??%) percentage, two-row format: 'scanned: N' + 'collected: N'. dashboard.js bumped to v=14

## 2026-04-12 06:56
Added unresponsive-worker dedup + return logging: in-memory Set<number> tracks flagged workers; logs once on first detection (threshold 8 min, down from 20), logs 'tornato online' when heartbeat key reappears. No repeated spam.

## 2026-04-12 07:01
Watchdog heartbeat: Set replaced with Map<number,number> (last console log timestamp). Sentry fires once on first detection; console warn repeats every 10 min while worker stays unresponsive. Check interval remains 2 min.

## 2026-04-12 08:04
Updated README.md (root), llm-scraping-coordinator/README.md, llm-scraping-worker/README.md: replaced all zip/ZIP references with tar.zst/archive terminology to match actual zstd implementation in merge.py

## 2026-04-12 08:09
Removed /merge/quit endpoint and all 'quit' references from coordinator and worker README files. Decision table entries changed to 'done', self-termination description updated to reference upload completion instead of quit calls.

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

## 2026-04-13 12:42
Removed STACK_BATCH_COUNT from coordinator docs (CLAUDE.md Key Modules table + Environment section, README.md Configuration table + Stack task queue description). The variable was already removed from code in a previous session.

## 2026-04-13 15:39
Added FILE_EXTENSIONS env var to coordinator (config.mts, routes/worker.mts /config endpoint, README, CLAUDE.md). Workers now fetch extensions from /config instead of using hardcoded LANG_EXTENSIONS. Removed LANG_EXTENSIONS from filtering.py. Updated worker README, CLAUDE.md.

## 2026-04-13 15:39
Removed LANG_EXTENSIONS from filtering.py. Added fetch_file_extensions() to coordinator.py. clone_and_extract() now takes file_extensions param; collect_github() fetches extensions from coordinator at startup. Updated CLAUDE.md and README.md.

