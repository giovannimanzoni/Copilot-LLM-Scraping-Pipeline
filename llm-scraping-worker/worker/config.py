import logging
import os
import sys
from pathlib import Path

import sentry_sdk
import urllib3
from sentry_sdk.integrations.logging import LoggingIntegration
from sentry_sdk.transport import HttpTransport

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

# Suppress resource_tracker UserWarning about leaked semaphores on os._exit.
# We use os._exit() to avoid a pyarrow segfault on Python 3.14; this bypasses semaphore
# finalizers, causing the resource_tracker subprocess to warn at process exit. Setting
# PYTHONWARNINGS here ensures the subprocess inherits the suppression when it is spawned
# later (during the first multiprocessing operation by the datasets library).
_rt_filter = "ignore::UserWarning:multiprocessing.resource_tracker"
_existing_pw = os.environ.get("PYTHONWARNINGS", "")
if _rt_filter not in _existing_pw:
    os.environ["PYTHONWARNINGS"] = (_existing_pw + "," + _rt_filter).lstrip(",")

# ─────────────────────────────────────────
# .ENV — load before any os.environ access; existing env vars take precedence
# ─────────────────────────────────────────

_env_path = Path(__file__).resolve().parent.parent / ".env"
if _env_path.exists():
    for _line in _env_path.read_text().splitlines():
        _line = _line.strip()
        if not _line or _line.startswith("#") or "=" not in _line:
            continue
        _key, _, _val = _line.partition("=")
        _key = _key.strip()
        if not _key or _key in os.environ:
            continue
        _val = _val.strip()
        if len(_val) >= 2 and _val[0] == _val[-1] and _val[0] in ('"', "'"):
            _val = _val[1:-1]
        os.environ[_key] = _val


# ─────────────────────────────────────────
# SENTRY — must initialise before anything else imports sentry_sdk
# ─────────────────────────────────────────

class NoVerifyHttpTransport(HttpTransport):
    """Skip SSL verification for self-signed Sentry certificates."""

    def _get_pool_options(self) -> dict:
        opts = super()._get_pool_options()
        opts["cert_reqs"] = "CERT_NONE"
        opts.pop("ca_certs", None)
        return opts


sentry_sdk.init(
    dsn=os.environ["SENTRY_DSN"],
    environment=os.environ.get("SENTRY_ENVIRONMENT", "production"),
    release="worker@1.0.0",
    transport=NoVerifyHttpTransport,
    traces_sample_rate=1.0,
    profile_session_sample_rate=0.0,
    enable_logs=True,
    send_default_pii=False,
    integrations=[
        LoggingIntegration(
            level=logging.INFO,
            event_level=logging.ERROR,
        ),
    ],
    before_send=lambda event, hint: event,
)

# ─────────────────────────────────────────
# LOGGING
# ─────────────────────────────────────────

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s][%(name)s] %(message)s",
)

logging.getLogger("httpx").setLevel(logging.WARNING)
logging.getLogger("httpcore").setLevel(logging.WARNING)
logging.getLogger("urllib3.connectionpool").setLevel(logging.WARNING)

# ─────────────────────────────────────────
# CONFIG
# ─────────────────────────────────────────

NODE_NAME = os.environ["NODE_NAME"]
if not (1 <= len(NODE_NAME) <= 8) or not all(0x20 <= ord(c) <= 0x7E for c in NODE_NAME):
    print(f"ERROR: NODE_NAME must be 1–8 printable ASCII characters, got: '{NODE_NAME}'", flush=True)
    os._exit(1)

_node_formatter = logging.Formatter(f"%(asctime)s [%(levelname)s][%(name)s:{NODE_NAME}] %(message)s")
for _handler in logging.getLogger().handlers:
    _handler.setFormatter(_node_formatter)

NODE_HASH = os.environ["NODE_HASH"]
if len(NODE_HASH) != 8 or not all(0x20 <= ord(c) <= 0x7E for c in NODE_HASH):
    print(f"ERROR: NODE_HASH must be exactly 8 printable ASCII characters, got: '{NODE_HASH}'", flush=True)
    os._exit(1)

_threads_phase1_env = os.environ.get("THREADS_PHASE1")
THREADS_PHASE1: int | None = int(_threads_phase1_env) if _threads_phase1_env is not None else None

_threads_phase2_env = os.environ.get("THREADS_PHASE2")
THREADS_PHASE2: int | None = int(_threads_phase2_env) if _threads_phase2_env is not None else None

log = logging.getLogger("worker")  # machine-level logger; threads use getLogger(f"node{node_id}")

COORDINATOR_URL = os.environ["COORDINATOR_URL"]
GITHUB_TOKEN    = os.environ["GITHUB_TOKEN"]
HF_TOKEN        = os.environ.get("HF_TOKEN")


_clone_timeout_env = os.environ.get("CLONE_TIMEOUT")
CLONE_TIMEOUT: int | None = int(_clone_timeout_env) if _clone_timeout_env is not None else None

_tmpfs_dir_env = os.environ.get("TMPFS_DIR")
if _tmpfs_dir_env is None:
    sys.exit("TMPFS_DIR must be taken from env var, quit if not defined")
TMPFS_DIR = Path(_tmpfs_dir_env)
DATA_DIR1 = Path("./data/data1")
DATA_DIR2 = Path("./data/data2")
DATA_DIR3 = Path("./data/data3")

GITHUB_HEADERS = {
    "Authorization": f"Bearer {GITHUB_TOKEN}",
    "Accept": "application/vnd.github+json",
    "X-GitHub-Api-Version": "2026-03-10",
}

DATA_DIR1.mkdir(exist_ok=True)
DATA_DIR2.mkdir(exist_ok=True)
DATA_DIR3.mkdir(exist_ok=True)

sentry_sdk.set_tag("coordinator", COORDINATOR_URL)


def node_paths(node_id: int) -> tuple[Path, str, str, str]:
    """Return (checkpoints_dir, cache_dir, phase1_output, phase2_output) for the given node_id.

    phase1_output is the GitHub dataset dir (under data1/).
    phase2_output is the Stack dataset dir (under data2/).

    Called once per thread at startup; the returned directories are created by
    the caller (thread_main) so that module-load time only creates DATA_DIR1/2/3.
    """
    checkpoints = DATA_DIR1 / f"checkpoints_node{node_id}"
    cache       = str(DATA_DIR2 / f"hf_cache_node{node_id}")
    output1     = str(DATA_DIR1 / f"dataset_node{node_id}")
    output2     = str(DATA_DIR2 / f"dataset_node{node_id}")
    return checkpoints, cache, output1, output2
