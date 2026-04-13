#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.14.2"
# dependencies = ["sentry-sdk"]
# ///
"""Claude reads this at session start to restore context."""
import json
import os
from io import StringIO

import sentry_sdk

def load_env():
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


def load_all():
  output = StringIO()

  path = os.path.join(CONTEXT_DIR, "state.json")
  if not os.path.exists(path):
    output.write("No saved context yet.\n")
  else:
    try:
      raw = open(path).read().strip()
      if not raw:
        output.write("No saved context yet (state.json is empty).\n")
      else:
        state = json.loads(raw)
        output.write("=== Saved Context ===\n")
        for key, data in state.items():
          output.write(f"  {key}: {data['value']}  (saved: {data['updated']})\n")
    except json.JSONDecodeError as e:
      sentry_sdk.capture_exception(e)
      output.write(f"Warning: state.json is corrupted ({e}), skipping.\n")
    except OSError as e:
      sentry_sdk.capture_exception(e)
      output.write(f"Warning: could not read state.json ({e}), skipping.\n")

  for fname in ["decisions.md", "progress.md"]:
    fpath = os.path.join(CONTEXT_DIR, fname)
    if os.path.exists(fpath):
      try:
        content = open(fpath).read()
        # Truncate at a line boundary to avoid splitting mid-line or mid-block
        if len(content) > 2000:
          content = content[-2000:]
          newline_pos = content.find("\n")
          if newline_pos != -1:
            content = content[newline_pos + 1:]
        output.write(f"\n=== {fname} ===\n")
        output.write(content)
      except OSError as e:
        sentry_sdk.capture_exception(e)
        output.write(f"Warning: could not read {fname} ({e}), skipping.\n")

  content = output.getvalue()

  # Print for human reading in terminal
  print(content)

  # Write snapshot for Claude to read
  snapshot_path = os.path.join(CONTEXT_DIR, "context_snapshot.md")
  try:
    os.makedirs(CONTEXT_DIR, exist_ok=True)
    with open(snapshot_path, "w") as f:
      f.write(content)
  except OSError as e:
    sentry_sdk.capture_exception(e)
    print(f"Error: could not write snapshot ({e})")


if __name__ == "__main__":
  load_all()
