"""In-memory brute-force throttling for login attempts.

Single-process by design (matches the single-machine Fly deployment).
Tracks failed attempts per IP and per username over a sliding window and
locks the bucket out once the cap is hit. Successful login clears both buckets.
"""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass, field


@dataclass
class _Bucket:
    failures: list[float] = field(default_factory=list)
    locked_until: float = 0.0


class LoginRateLimiter:
    def __init__(
        self,
        max_per_ip: int = 20,
        max_per_username: int = 8,
        window_seconds: float = 300.0,
        lockout_seconds: float = 900.0,
    ) -> None:
        self._max_per_ip = max_per_ip
        self._max_per_username = max_per_username
        self._window = window_seconds
        self._lockout = lockout_seconds
        self._by_ip: dict[str, _Bucket] = {}
        self._by_username: dict[str, _Bucket] = {}
        self._lock = threading.Lock()

    def check(self, ip: str, username: str) -> int | None:
        """Return seconds until retry is allowed, or None if the attempt may proceed."""
        now = time.monotonic()
        with self._lock:
            retry = 0.0
            for bucket in (self._by_ip.get(ip), self._by_username.get(username.lower())):
                if bucket and bucket.locked_until > now:
                    retry = max(retry, bucket.locked_until - now)
            if retry > 0:
                return max(1, int(retry))
            return None

    def record_failure(self, ip: str, username: str) -> None:
        now = time.monotonic()
        with self._lock:
            self._prune(now)
            for key, buckets, cap in (
                (ip, self._by_ip, self._max_per_ip),
                (username.lower(), self._by_username, self._max_per_username),
            ):
                bucket = buckets.setdefault(key, _Bucket())
                bucket.failures = [t for t in bucket.failures if now - t < self._window]
                bucket.failures.append(now)
                if len(bucket.failures) >= cap:
                    bucket.locked_until = now + self._lockout
                    bucket.failures.clear()

    def record_success(self, ip: str, username: str) -> None:
        with self._lock:
            self._by_ip.pop(ip, None)
            self._by_username.pop(username.lower(), None)

    def _prune(self, now: float) -> None:
        for buckets in (self._by_ip, self._by_username):
            stale = [
                key
                for key, b in buckets.items()
                if b.locked_until <= now
                and all(now - t >= self._window for t in b.failures)
            ]
            for key in stale:
                del buckets[key]


login_limiter = LoginRateLimiter()


class AttemptRateLimiter:
    """Throttle any repeated action (e.g. LAN room join probes), not just failures."""

    def __init__(
        self,
        max_attempts: int = 30,
        window_seconds: float = 300.0,
        lockout_seconds: float = 600.0,
    ) -> None:
        self._max = max_attempts
        self._window = window_seconds
        self._lockout = lockout_seconds
        self._buckets: dict[str, _Bucket] = {}
        self._lock = threading.Lock()

    def hit(self, *keys: str) -> int | None:
        """Record an attempt for each key. Return Retry-After seconds if locked."""
        now = time.monotonic()
        with self._lock:
            retry = 0.0
            for key in keys:
                bucket = self._buckets.setdefault(key, _Bucket())
                if bucket.locked_until > now:
                    retry = max(retry, bucket.locked_until - now)
                    continue
                bucket.failures = [t for t in bucket.failures if now - t < self._window]
                bucket.failures.append(now)
                if len(bucket.failures) >= self._max:
                    bucket.locked_until = now + self._lockout
                    bucket.failures.clear()
                    retry = max(retry, self._lockout)
            # Drop idle unlocked buckets
            stale = [
                k
                for k, b in self._buckets.items()
                if b.locked_until <= now
                and all(now - t >= self._window for t in b.failures)
            ]
            for k in stale:
                del self._buckets[k]
            if retry > 0:
                return max(1, int(retry))
            return None


# Room-code join probes: per-IP + per-user (authenticated) windows.
lan_join_limiter = AttemptRateLimiter(
    max_attempts=20,
    window_seconds=300.0,
    lockout_seconds=600.0,
)
