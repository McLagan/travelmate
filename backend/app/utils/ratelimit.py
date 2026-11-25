"""
Small in-memory sliding-window limiter for the auth endpoints (login, registration, password reset).
Per process: with several workers each keeps its own counters - fine for one server; use Redis when scaling out.
"""

import threading
import time
from collections import defaultdict, deque
from typing import Deque, Dict

from fastapi import HTTPException, status

_lock = threading.Lock()
_hits: Dict[str, Deque[float]] = defaultdict(deque)


def _prune(q: Deque[float], window: float, now: float):
    while q and q[0] <= now - window:
        q.popleft()


def retry_after(key: str, limit: int, window: float) -> int:
    """Seconds until one more hit is allowed under `key` (0 = allowed now). Does not record anything."""
    now = time.time()
    with _lock:
        q = _hits[key]
        _prune(q, window, now)
        if len(q) < limit:
            return 0
        return max(1, int(q[0] + window - now) + 1)


def record(key: str):
    with _lock:
        _hits[key].append(time.time())


def reset(key: str):
    with _lock:
        _hits.pop(key, None)


def check_and_record(key: str, limit: int, window: float):
    """Count this request; 429 when over the limit."""
    wait = retry_after(key, limit, window)
    if wait:
        too_many(wait)
    record(key)


def too_many(wait: int):
    minutes = max(1, round(wait / 60))
    raise HTTPException(
        status_code=status.HTTP_429_TOO_MANY_REQUESTS,
        detail=f"Too many attempts. Try again in {minutes} min.",
        headers={"Retry-After": str(wait)},
    )
