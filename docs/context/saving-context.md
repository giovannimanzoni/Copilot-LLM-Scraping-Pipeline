# Context Persistence

Saves go to disk immediately — not to conversation memory. The context window is limited.
Persisting to files means future sessions start with full knowledge of past work, `/compact`
and session resets don't lose critical state, and you never ask the user to repeat themselves.
You have to manage 2 projects:
  1. llm-scraping-coordinator, the "coordinator" project
  2. llm-scraping-worker, the "worker" project
Update the context of the project you have edited.

## MANDATORY
The following scripts/commands/instructions are valid if you run them in each project folder.

---

## Commands

**Save a key fact to `state.json`:**

```
uv run --script .claude/scripts/save_context.py "current_task" "refactoring auth module"
```

**Log a decision to `decisions.md`:**

```
uv run --script .claude/scripts/save_context.py --log decisions.md "Using JWT over sessions because stateless API needed"
```

**Log progress to `progress.md`:**

```
uv run --script .claude/scripts/save_context.py --log progress.md "Completed: user model. Next: auth routes"
```

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

```
uv run --script .claude/scripts/save_context.py "current_task" "<what you are about to do>"
```

### After completing any task

Run **all** of these before telling the user you are done:

```
uv run --script .claude/scripts/save_context.py "current_task" "DONE: <what was completed>"
uv run --script .claude/scripts/save_context.py "next_task" "<what comes next, or 'none'>"
uv run --script .claude/scripts/save_context.py --log progress.md "<what was completed and what is next>"
```

### After any architectural decision

```
uv run --script .claude/scripts/save_context.py --log decisions.md "<decision and reason>"
```

### When the user states or corrects anything

Save it **immediately** — do not defer to the end of the task:

```
uv run --script .claude/scripts/save_context.py "<key>" "<what the user said>"
```

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
