"""In-memory request and provider-attempt limits.

No caller identity can be verified behind the Next.js/Vercel proxy (forwarding headers are
client-writable), so each limit is one bucket shared by every caller. State is per process and
resets on restart.
"""

import math
import threading
import time
from collections import deque

from .config import get_settings

DAY_SECONDS = 86_400


class SlidingWindow:
    """At most `limit` acquisitions per `window` seconds. Memory is O(limit)."""

    def __init__(self, limit: int, window: float, clock=time.monotonic):
        self.limit, self.window, self._clock = limit, window, clock
        self._times: deque[float] = deque(maxlen=limit)
        self._lock = threading.Lock()

    def acquire(self) -> int | None:
        """Reserve one slot. Returns None when admitted, else whole seconds until one frees."""
        with self._lock:
            now = self._clock()
            while self._times and self._times[0] <= now - self.window:
                self._times.popleft()
            if len(self._times) < self.limit:
                self._times.append(now)
                return None
            return max(1, math.ceil(self._times[0] + self.window - now))


_clock = time.monotonic
_windows: dict[str, SlidingWindow] = {}
_registry_lock = threading.Lock()


def _window(name: str, limit: int, seconds: float) -> SlidingWindow:
    with _registry_lock:
        w = _windows.get(name)
        if w is None or w.limit != limit:
            w = _windows[name] = SlidingWindow(limit, seconds, lambda: _clock())
        return w


def route_window(route: str) -> SlidingWindow:
    s = get_settings()
    limit = {"map": s.rate_limit_map_per_minute, "suggest": s.rate_limit_suggest_per_minute}
    return _window(f"route:{route}", limit[route], 60)


def provider_window() -> SlidingWindow:
    return _window("provider", get_settings().provider_attempts_per_day, DAY_SECONDS)


def reset() -> None:
    with _registry_lock:
        _windows.clear()
