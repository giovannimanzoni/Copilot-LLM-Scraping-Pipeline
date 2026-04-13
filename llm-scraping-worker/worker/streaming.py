import queue
import threading
import time
from typing import Any, Iterator

from worker.config import log
from worker.coordinator import coord_post


class StackProgress:
    """Thread-safe progress counter shared between the streaming loop and the reporter."""

    __slots__ = ("lang", "batch_index", "total", "scanned", "samples", "_start", "_lock")

    def __init__(self, lang: str, batch_index: int, total: int | None = None) -> None:
        self.lang        = lang
        self.batch_index = batch_index
        self.total       = total
        self.scanned     = 0
        self.samples     = 0
        self._start      = time.monotonic()
        self._lock       = threading.Lock()

    def update(self, scanned: int, samples: int) -> None:
        with self._lock:
            self.scanned = scanned
            self.samples = samples

    def snapshot(self) -> dict:
        with self._lock:
            elapsed = time.monotonic() - self._start
            rate    = self.scanned / elapsed if elapsed > 0 else 0
            pct     = (self.scanned / self.total * 100) if self.total else None
            return {
                "lang":        self.lang,
                "batch_index": self.batch_index,
                "total":       self.total,
                "scanned":     self.scanned,
                "samples":     self.samples,
                "elapsed":     elapsed,
                "rate":        rate,
                "pct":         pct,
            }


def stream_with_timeout(iterable: Any, item_timeout: int = 300) -> Iterator:
    """Wrap an iterable with a per-item deadline using a background producer thread.

    Yields items from *iterable* as normal.  If no item arrives within
    *item_timeout* seconds the consumer raises TimeoutError, preventing a
    stalled HuggingFace/network stream from hanging a worker indefinitely.

    The producer thread is daemonized so it never blocks process exit.
    """
    q: queue.Queue = queue.Queue(maxsize=8)
    _DONE = object()

    def _producer() -> None:
        try:
            for item in iterable:
                q.put(item)
        except Exception as exc:
            q.put(exc)
        finally:
            q.put(_DONE)

    threading.Thread(target=_producer, daemon=True).start()

    while True:
        try:
            item = q.get(timeout=item_timeout)
        except queue.Empty:
            raise TimeoutError(f"Stream stalled — no item received in {item_timeout}s")
        if item is _DONE:
            return
        if isinstance(item, Exception):
            raise item
        yield item


def stack_progress_reporter(progress: StackProgress, node_id: int, interval: int = 10) -> threading.Event:
    """Start a background thread that logs progress and sends enriched heartbeats.

    Returns a stop Event — set it to shut the thread down cleanly.
    """
    stop = threading.Event()

    def _run() -> None:
        while not stop.wait(interval):
            s = progress.snapshot()
            pct_str = f"  {s['pct']:.1f}% of ~{s['total']:,}" if s["pct"] is not None else ""
            log.info(
                f"  [stack] node{node_id} {s['lang']} batch{s['batch_index']}: "
                f"{s['scanned']:,} scanned{pct_str}, "
                f"{s['samples']:,} collected "
                f"({s['elapsed']:.0f}s, {s['rate']:.0f} it/s)"
            )
            try:
                coord_post("/heartbeat", {
                    "node_id":       node_id,
                    "current_stack": s["lang"],
                    "stack_scanned": s["scanned"],
                    "stack_total":   s["total"],
                    "stack_samples": s["samples"],
                })
            except Exception:
                pass  # heartbeat failure is non-fatal

    threading.Thread(target=_run, daemon=True).start()
    return stop
