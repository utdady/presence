"""TURN relay credentials via Metered (Open Relay).

The credential-scoped API key stays server-side (Fly secrets); clients get the
ICE servers array from GET /webrtc/ice-servers. When no key is configured this
degrades to public STUN only (calls then require a direct P2P path).

The array is cached and shared across users — Metered's Get Credential
endpoint returns the same relay credential either way, and caching keeps us at
~2 API calls per hour.
"""

from __future__ import annotations

import json
import threading
import time
import urllib.request
from typing import Any

from app.config import settings

FALLBACK_ICE_SERVERS: list[dict[str, Any]] = [
    {"urls": ["stun:stun.cloudflare.com:3478"]},
    {"urls": ["stun:stun.l.google.com:19302"]},
]

_CACHE_SECONDS = 30 * 60

_lock = threading.Lock()
_cached: list[dict[str, Any]] | None = None
_cached_until = 0.0


def get_ice_servers() -> list[dict[str, Any]]:
    global _cached, _cached_until
    if not settings.turn_app_name or not settings.turn_api_key:
        return FALLBACK_ICE_SERVERS
    now = time.monotonic()
    with _lock:
        if _cached is not None and now < _cached_until:
            return _cached
    try:
        servers = _fetch_from_metered()
    except Exception:
        # Metered unreachable — serve stale servers if any, else STUN-only.
        with _lock:
            return _cached if _cached is not None else FALLBACK_ICE_SERVERS
    with _lock:
        _cached = servers
        _cached_until = now + _CACHE_SECONDS
    return servers


def _fetch_from_metered() -> list[dict[str, Any]]:
    url = (
        f"https://{settings.turn_app_name}.metered.live/api/v1/turn/credentials"
        f"?apiKey={settings.turn_api_key}"
    )
    with urllib.request.urlopen(url, timeout=10) as resp:
        body = json.load(resp)
    if not isinstance(body, list) or not body:
        raise ValueError("Unexpected Metered TURN response")
    for entry in body:
        if not isinstance(entry, dict) or "urls" not in entry:
            raise ValueError("Unexpected Metered TURN response")
    return body
