@.claude/project-skills.md

# Context

## MANDATORY: Session Start Protocol

Read @docs/context/session-start-protocol.md

## MANDATORY: Saving Context

Read @docs/context/saving-context.md

# Development

## MANDATORY: Quality Checks

Before considering the task done,
lint and type check. Run these commands from this folder (no file output):

```bash
# Type check only
yarn run coordinatorTypeCheck

# Lint
yarn run coordinatorLint

# Both
yarn run coordinatorTypeCheckLint
```

No test suite configured.

## Codebase

Entry point is `src/coordinator.mts`. Run with `yarn start`.

```
src/
  coordinator.mts         ← bootstrap: Koa server, Sentry, graceful shutdown
  app.mts                 ← middleware pipeline + route mounting (7 routers)
  instrument.mts          ← Sentry init (patches HTTPS for bugsink.lan)
  config.mts              ← constants: PORT, timeouts, STACK_TASKS
  init.mts                ← Redis connect + seed queries/stack tasks on startup
  redis-keys.mts          ← Redis key definitions and schema documentation
  validate.mts            ← Zod request-body validation wrapper (throws 400 on failure)
  status.mts              ← getStatusData() fleet summary, getRedisData() key inspector
  watchdog.mts            ← 4 background intervals: repo timeout, stack timeout, phase watcher, heartbeat monitor
  stack-seeder.mts        ← fetches bigcode/the-stack Parquet shard list from HF, creates batched tasks
  routes/
    worker.mts            ← POST /worker/register, POST /heartbeat
    repos.mts             ← /repos/* (register, next, batch, done, fail)
    stack.mts             ← /stack/next/:nodeId, /stack/done
    fleet.mts             ← /fleet/state, /fleet/phase/*, /fleet/auto_advance, etc.
    reset.mts             ← /reset/* bulk reset operations (re-seeds from input_data/repos_found.txt)
    dashboard.mts         ← HTML dashboards + SSE streams (/events, /redis/events) + static assets
    utility.mts           ← GET /utility/repo-scanner/stream — SSE repo scanner (writes input_data/repos_found.txt)
  dashboard.html          ← Fleet status dashboard
  redis-dashboard.html    ← Redis key inspector UI
  reset-dashboard.html    ← Reset control panel UI
  queries-generator.html  ← Query Generator utility UI (/queries-gen)
  static/                 ← CSS/JS for all four dashboards
```

## Key Modules

| Module             | Purpose                                                                                                                           |
|--------------------|-----------------------------------------------------------------------------------------------------------------------------------|
| `watchdog.mts`     | Repo timeout recovery (60 s), stack timeout marking (5 min), phase auto-advance with error-halt (5 s), dead-worker alerts (2 min) |
| `init.mts`         | Idempotent seeding: skips if Redis already has data                                                                               |
| `stack-seeder.mts` | Fetches HF shard list via `HF_TOKEN`, splits into `STACK_BATCH_COUNT` tasks                                                       |
| `status.mts`       | Two aggregation views consumed by `/status` and SSE streams                                                                       |
| `validate.mts`     | Wraps all route handlers — throws HTTP 400 with Zod error details                                                                 |

## Non-Obvious Constraints

- **`REDIS_KEY` prefix uses hash tags** (`{repos}`, `{queries}`, `{stack}`, `{node}`) — keeps related keys on the same
  cluster slot for multi-key atomic operations. Do not change the tag structure.
- **Stack tasks time out to `{stack}:problematic`** — they are NOT automatically re-queued. Use
  `POST /reset/problematic`
  to recover them.
- **`fleet:phase_error` is set when auto-advance halts due to errors** — when `fleet:auto_advance=1` and a phase
  completes with errors (phase 3: `stack_problematic` count > 0), the phase counter advances but `fleet:state` is set to
  `"stopped"` and `fleet:phase_error` is set to `"1"`. The dashboard shows a red banner. Cleared by any reset operation
  or by `POST /fleet/phase/start`.
- **`fleet:state` missing = running** — do not rely on its presence; treat absence as `"running"`.
- **Port is 3981** — hardcoded in `config.mts`, not overridable via env.


## Gotchas

- Sentry (`src/instrument.mts`) patches HTTPS to disable cert verification for local BugSink instance.

## Environment

Config in `.env`. Key variables: `REDIS_IS_CLUSTER`,
`REDIS_DB{1,2,3}_HOST/PORT`, `REDIS_USERNAME`, `REDIS_PASSWORD`, `REDIS_KEY`, `SENTRY_DSN`, `SENTRY_ENVIRONMENT`,
`THE_STACK_LANGUAGES` (comma-separated Stack languages, default `typescript`),
`FILE_EXTENSIONS` (comma-separated file extensions for GitHub collection, default `.ts,.mts,.cts`).

