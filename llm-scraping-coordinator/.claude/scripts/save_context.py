#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.14.2"
# dependencies = ["sentry-sdk"]
# ///
"""Claude uses this to persist context to disk."""
import json
import os
import sys
from datetime import datetime
from io import StringIO

import sentry_sdk


def load_env() -> None:
  env_path = os.path.join(os.path.dirname(__file__), "../../.env.local")
  if not os.path.exists(env_path):
    return
  with open(env_path) as f:
    for line in f:
      line = line.strip()
      if not line or line.startswith("#") or "=" not in line:
        continue
      key, _, value = line.partition("=")
      os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


load_env()

_sentry_dsn = os.environ.get("SENTRY_DSN")
if _sentry_dsn:
  sentry_sdk.init(
    dsn=_sentry_dsn,
    environment=os.environ.get("SENTRY_ENVIRONMENT", "production"),
    release=os.environ.get("SENTRY_RELEASE"),
  )
else:
  print("Warning: SENTRY_DSN not set — Sentry disabled.")

CONTEXT_DIR = os.path.join(os.path.dirname(__file__), "../context")
MEMORY_PATH = os.path.join(os.path.dirname(__file__), "../MEMORY.md")

os.makedirs(CONTEXT_DIR, exist_ok=True)


def refresh_snapshot() -> None:
  """Regenerate context_snapshot.md so it's always current after any save."""
  output = StringIO()
  path = os.path.join(CONTEXT_DIR, "state.json")
  if os.path.exists(path):
    try:
      raw = open(path).read().strip()
      if raw:
        state = json.loads(raw)
        output.write("=== Saved Context ===\n")
        for key, data in state.items():
          output.write(f"  {key}: {data['value']}  (saved: {data['updated']})\n")
    except json.JSONDecodeError as e:
      sentry_sdk.capture_exception(e)
      output.write("Warning: state.json is corrupted, skipping.\n")

  for fname in ["decisions.md", "progress.md"]:
    fpath = os.path.join(CONTEXT_DIR, fname)
    if os.path.exists(fpath):
      content = open(fpath).read()
      if len(content) > 2000:
        content = content[-2000:]
        newline_pos = content.find("\n")
        if newline_pos != -1:
          content = content[newline_pos + 1:]
      output.write(f"\n=== {fname} ===\n")
      output.write(content)

  try:
    with open(os.path.join(CONTEXT_DIR, "context_snapshot.md"), "w") as f:
      f.write(output.getvalue())
  except OSError as e:
    sentry_sdk.capture_exception(e)
    print(f"Error: could not write context_snapshot.md ({e})")


def drain_memory() -> None:
  """Merge MEMORY.md into the structured context, then clear it.

  Called automatically after every save so MEMORY.md never accumulates
  knowledge that isn't already in context_snapshot.md.
  The caller (Claude) is responsible for deduplication: only new
  information not already present in state.json or the logs is written.
  This function handles the mechanical drain — read, append to progress.md
  as a clearly marked block, then wipe the file.
  """
  if not os.path.exists(MEMORY_PATH):
    return

  try:
    content = open(MEMORY_PATH).read().strip()
    if not content:
      return

    log_path = os.path.join(CONTEXT_DIR, "progress.md")
    with open(log_path, "a") as f:
      f.write(f"\n## {datetime.now().strftime('%Y-%m-%d %H:%M')} [merged from MEMORY.md]\n")
      f.write(content)
      f.write("\n")

    # Clear MEMORY.md after merging so it doesn't re-surface next session
    open(MEMORY_PATH, "w").close()
    print("Merged MEMORY.md into progress.md and cleared it.")
  except OSError as e:
    sentry_sdk.capture_exception(e)
    print(f"Error: could not drain MEMORY.md ({e})")


def save(key: str, value: str) -> None:
  path = os.path.join(CONTEXT_DIR, "state.json")
  state = {}
  if os.path.exists(path):
    try:
      raw = open(path).read().strip()
      if raw:
        state = json.loads(raw)
    except json.JSONDecodeError as e:
      sentry_sdk.capture_exception(e)
      print("Warning: state.json was corrupted, resetting.")

  state[key] = {"value": value, "updated": datetime.now().isoformat()}
  try:
    with open(path, "w") as f:
      json.dump(state, f, indent=2)
  except OSError as e:
    sentry_sdk.capture_exception(e)
    print(f"Error: could not write state.json ({e})")
    return
  print(f"Saved: {key}")
  drain_memory()
  refresh_snapshot()


def append_log(filename: str, entry: str) -> None:
  path = os.path.join(CONTEXT_DIR, filename)
  try:
    with open(path, "a") as f:
      f.write(f"\n## {datetime.now().strftime('%Y-%m-%d %H:%M')}\n{entry}\n")
  except OSError as e:
    sentry_sdk.capture_exception(e)
    print(f"Error: could not write {filename} ({e})")
    return
  print(f"Logged to {filename}")
  drain_memory()
  refresh_snapshot()


if __name__ == "__main__":
  # Usage: save_context.py key "value"
  #        save_context.py --log decisions.md "decided X because Y"

  if len(sys.argv) < 3:
    print("Usage:")
    print("  save_context.py key 'value'")
    print("  save_context.py --log file.md 'entry'")
    sys.exit(1)

  if sys.argv[1] == "--log":
    if len(sys.argv) < 4:
      print("Usage: save_context.py --log file.md 'entry'")
      sys.exit(1)
    append_log(sys.argv[2], sys.argv[3])
  else:
    save(sys.argv[1], sys.argv[2])
