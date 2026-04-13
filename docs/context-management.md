# Context Management for Claude Code Sessions

This is an overview of how context is handled BY EACH SUBPROJECTS llm-scraping-coordinator and llm-scraping-worker.

## Overview

Claude Code has no memory between sessions — every new session starts from scratch. This solution provides persistent
memory across sessions using two scripts and a snapshot file that Claude reads automatically at startup.

---

## How It Works

### The Problem

Claude's context window is reset every session. Any knowledge of previous work, decisions, or progress is lost unless
explicitly saved somewhere Claude can read it.

### The Solution

Inside each project, two Python scripts manage a small persistent store on disk:

- `save_context.py` — writes key/value facts and append-only logs to disk
- `load_context.py` — reads everything back and generates a `context_snapshot.md`

Claude reads `context_snapshot.md` at the start of every session to restore its memory.

---

## File Structure

```
.claude/
├── scripts/
│   ├── load_context.py       # Reads context and generates snapshot
│   └── save_context.py       # Writes context to disk
├── context/
    ├── state.json            # Key/value store (current facts)
    ├── decisions.md          # Append-only log of architectural decisions
    ├── progress.md           # Append-only log of completed work
    └── context_snapshot.md   # Auto-generated — Claude reads this at session start
CLAUDE.md                 # Instructions to Claude
MEMORY.md                 # Claude's long term memory converted to a scratch pad — auto-drained into progress.md on every save
```

---

## Session Start Flow

```
1. You open terminal
       ↓
2. Shell alias runs load_context.py
       ↓
3. Script reads state.json + decisions.md + progress.md
       ↓
4. Script writes context_snapshot.md  ← also prints to your terminal
       ↓
5. You launch Claude Code
       ↓
6. Claude reads CLAUDE.md → reads context_snapshot.md
       ↓
7. Claude starts with full knowledge of past sessions ✓
```

### Shell Alias Setup

Add to your `~/.zshrc` or `~/.bashrc`:

```bash
alias claude='[ -f .claude/scripts/load_context.py ] && uv run --script .claude/scripts/load_context.py; command claude'
```

This only runs the script if it exists in the current directory, so the alias works safely across all your projects.

---

## Saving Context During a Session

Claude calls `save_context.py` proactively during work. There are two ways to save:

### Key/Value Facts

For current state, active tasks, preferences, and constraints:

```bash
uv run --script .claude/scripts/save_context.py "current_task" "refactoring auth module"
uv run --script .claude/scripts/save_context.py "preferred_style" "no comments in code"
uv run --script .claude/scripts/save_context.py "db_schema_version" "v4"
```

Stored in `state.json`. Each key overwrites the previous value — always reflects current state.

### Append-Only Logs

For decisions and progress that should be accumulated over time:

```bash
# Log an architectural decision
uv run --script .claude/scripts/save_context.py --log decisions.md "Using JWT over sessions — stateless API needed"

# Log progress
uv run --script .claude/scripts/save_context.py --log progress.md "Completed: user model. Next: auth routes"
```

Stored in `decisions.md` and `progress.md`. Each entry is timestamped and appended — never overwritten.

### Snapshot Auto-Refresh

Every call to `save_context.py` automatically regenerates `context_snapshot.md`. The snapshot is always up to date, even
mid-session.

### MEMORY.md — Freeform Scratch Pad

`MEMORY.md` (at the project root, alongside `CLAUDE.md`) is a freeform file Claude can write to at any point during a
session — useful for jotting down a thought before a formal save, or for noting something mid-task without interrupting
flow.

It is **not a permanent store**. Every call to `save_context.py` automatically triggers `drain_memory()`, which:

1. Appends the full contents of `MEMORY.md` to `progress.md` under a timestamped heading
2. Clears `MEMORY.md` so it never accumulates stale notes across saves

This means anything written to `MEMORY.md` will survive into `context_snapshot.md` as long as a save happens before the
session ends. If a session ends without any save, `MEMORY.md` content is **not** automatically merged — it stays on disk
until the next save drains it.

The intended workflow is:

```
Claude writes a note to MEMORY.md mid-task
       ↓
Claude calls save_context.py for any reason (task start, decision, progress)
       ↓
drain_memory() merges MEMORY.md → progress.md, then clears MEMORY.md
       ↓
refresh_snapshot() includes the merged note in context_snapshot.md ✓
```

Prefer `state.json` (key/value saves) for anything that reflects current state. Use `MEMORY.md` only for transient notes
that will be absorbed into `progress.md` on the next save.

---

## What Gets Saved

| Type          | File                  | Behaviour                               | Example                       |
|---------------|-----------------------|-----------------------------------------|-------------------------------|
| Current facts | `state.json`          | Overwrites per key                      | `current_task`, `api_version` |
| Decisions     | `decisions.md`        | Append with timestamp                   | Why JWT was chosen            |
| Progress      | `progress.md`         | Append with timestamp                   | What's done, what's next      |
| Scratch notes | `MEMORY.md`           | Drained into `progress.md` on each save | Mid-task thoughts             |
| Snapshot      | `context_snapshot.md` | Auto-regenerated                        | Everything Claude reads       |

---

## CLAUDE.md Instructions

The `CLAUDE.md` file tells Claude when and how to use the scripts.

### Session Start Protocol:

```markdown
# MANDATORY: Session Start Protocol

At the start of EVERY session, before doing anything else:

1. Read `.claude/context/context_snapshot.md` — this is your complete memory of
   previous sessions. No other files need to be read; the snapshot is always current.
```

### Context Persistence:

Claude writes MEMORY.md at its own discretion when it judges something worth preserving mid-session.

```markdown
# Context Persistence

Saves go to disk immediately — not to conversation memory. The context window is limited.
Persisting to files means future sessions start with full knowledge of past work, `/compact`
and session resets don't lose critical state, and you never ask the user to repeat themselves.

---

## Commands

**Save a key fact to `state.json`:**
uv run --script .claude/scripts/save_context.py "current_task" "refactoring auth module"

**Log a decision to `decisions.md`:**
uv run --script .claude/scripts/save_context.py --log decisions.md "Using JWT over sessions because stateless API
needed"

**Log progress to `progress.md`:**
uv run --script .claude/scripts/save_context.py --log progress.md "Completed: user model. Next: auth routes"

Every save automatically:

- Merges any new content from `.claude/MEMORY.md` into `progress.md` and clears it
- Regenerates `context_snapshot.md` so the next session starts complete

You never need to read or manage `MEMORY.md` directly.

---

## `state.json` vs logs — which to use

- **`state.json`** is for **current state**: things that have one canonical value at a time
  (e.g. `current_task`, `preferred_language`, `db_type`). Saving the same key overwrites it.
  Prefer key/value over logs for anything reflecting current state.
- **`decisions.md`** and **`progress.md`** are **append-only logs**: never overwrite, always append.
  Use them when both the old and new values are worth keeping.
- When in doubt: if the old value is no longer true → use `state.json`.
  If both old and new are worth keeping → use a log.

---

## MANDATORY: When to Save

These are not reminders. Skipping any of these is an error.

### Before starting any task

Run this **first**, before writing a single line of code or making any change:
uv run --script .claude/scripts/save_context.py "current_task" "<what you are about to do>"

### After completing any task

Run **all** of these before telling the user you are done:
uv run --script .claude/scripts/save_context.py "current_task" "DONE: <what was completed>"
uv run --script .claude/scripts/save_context.py "next_task" "<what comes next, or 'none'>"
uv run --script .claude/scripts/save_context.py --log progress.md "<what was completed and what is next>"

### After any architectural decision

uv run --script .claude/scripts/save_context.py --log decisions.md "<decision and reason>"

### When the user states or corrects anything

Save it **immediately** — do not defer to the end of the task:
uv run --script .claude/scripts/save_context.py "<key>" "<what the user said>"

### Before any long operation

Save current state before starting — if the context window fills, the save must already exist.

### When a `state.json` value becomes outdated

Overwrite it immediately with the new value.

---

## Self-Check Before Every Response

Before replying to the user, ask: **did anything in this turn require a save?**
If yes and you have not saved yet — save before replying.

---

## MANDATORY: Session End Protocol

When a task is fully complete:

1. Run all mandatory saves (`progress.md`, `state.json`, `decisions.md` if applicable).
2. Tell the user: *"Task complete. You should end this session and start a new one."*

Do not start a new task in the same session after signaling completion.
A new session ensures the next task starts from a clean, fully persisted state.
```

---

## Why Not Use Hooks?

Claude Code hooks (`PreToolUse`, `PostToolUse`, `Stop`) could theoretically trigger these scripts, but they don't fit
well:

- There is no "session start" hook — the closest is `PreToolUse`, which fires before **every** tool call, not just once
  at startup
- Running `load_context.py` repeatedly mid-session is wasteful and the output would not be read by Claude anyway
- The shell alias approach guarantees the snapshot is fresh **before** Claude launches, with zero ambiguity

---

## Limitations

- `context_snapshot.md` only shows the last 2000 characters of each log file (decisions.md, progress.md) — old entries
  are preserved on disk but not shown to Claude
- If Claude skips reading `CLAUDE.md` (rare but possible after `/compact`), it may miss the snapshot — saving critical
  facts as key/value in `state.json` is more reliable than relying solely on logs
- `MEMORY.md` is only drained when `save_context.py` is called — if a session ends without any save, its contents remain
  on disk unmerged and will be absorbed on the first save of the next session (which may cause stale notes to surface
  unexpectedly). Claude docs say that Claude read MEMORY.md at the beginning of each session.
- The scripts require `uv` — ensure it is available in your environment
