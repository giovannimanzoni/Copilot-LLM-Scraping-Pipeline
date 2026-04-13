import signal as _signal

# Reset SIGINT to the OS default (terminate) before any imports.
# Python installs its own SIGINT handler (raises KeyboardInterrupt) during
# interpreter init; pyarrow/datasets install C++ sigaction handlers at import
# time.  Both of those code paths segfault on Python 3.14 during Ctrl+C.
# SIG_DFL makes the OS kill the process directly — no Python exception
# unwinding, no C++ destructors, no segfault, no traceback.
_signal.signal(_signal.SIGINT, _signal.SIG_DFL)

import argparse  # noqa: E402

from worker.main import multi_worker_main  # noqa: E402


def main() -> None:
    parser = argparse.ArgumentParser(description="LLM scraping worker")
    parser.add_argument(
        "--threads-phase1",
        type=int,
        default=None,
        metavar="N",
        help="Thread count for phase 1 (GitHub); defaults to THREADS_PHASE1 env var or os.cpu_count()",
    )
    args = parser.parse_args()
    multi_worker_main(args.threads_phase1)


main()
