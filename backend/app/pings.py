"""Directed presence pings (account→account).

Rules (product):
- One active ping per directed pair (A→B).
- Only send when B is offline.
- No cancel for A; B clears only with Receive.
- Ignore: no reverse notify; timer keeps running.
- Active while A is online (any device); expires_at set to now+15m when A fully offline.
- If A returns online before expiry, clear expires_at again.
- Receive while A offline: reverse notify for 10 minutes when A reconnects or if online immediately.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any

OFFLINE_GRACE_SEC = 15 * 60
REVERSE_NOTIFY_SEC = 10 * 60


@dataclass
class ActivePing:
    from_id: str
    to_id: str
    created_at: float
    # None while pinger has ≥1 online device; wall-clock when offline.
    expires_at: float | None = None


@dataclass
class ReverseNotify:
    """A should be told that B received their ping."""

    pinger_id: str
    responder_id: str
    expires_at: float
    created_at: float = field(default_factory=time.time)


# (from_id, to_id) → ActivePing
_active: dict[tuple[str, str], ActivePing] = {}
# pinger_id → ReverseNotify (one at a time per pinger for simplicity;
# multiple responders overwrite only if different - store list)
_reverse: list[ReverseNotify] = []


def _now() -> float:
    return time.time()


def purge() -> list[dict[str, Any]]:
    """Drop expired pings / reverse rows. Returns events for WS fan-out."""
    now = _now()
    events: list[dict[str, Any]] = []
    dead = [
        k
        for k, p in _active.items()
        if p.expires_at is not None and p.expires_at <= now
    ]
    for k in dead:
        p = _active.pop(k)
        events.append(
            {
                "type": "ping_cleared",
                "from": p.from_id,
                "to": p.to_id,
                "reason": "expired",
            }
        )
    alive_rev: list[ReverseNotify] = []
    for r in _reverse:
        if r.expires_at > now:
            alive_rev.append(r)
    _reverse.clear()
    _reverse.extend(alive_rev)
    return events


def ping_public(p: ActivePing) -> dict[str, Any]:
    return {
        "from": p.from_id,
        "to": p.to_id,
        "created_at": p.created_at,
        "expires_at": p.expires_at,
        "status": "active",
    }


def get_active(from_id: str, to_id: str) -> ActivePing | None:
    purge()
    return _active.get((from_id, to_id))


def list_for_user(user_id: str) -> list[dict[str, Any]]:
    purge()
    out: list[dict[str, Any]] = []
    for p in _active.values():
        if p.from_id == user_id or p.to_id == user_id:
            out.append(ping_public(p))
    return out


def reverse_for_user(user_id: str) -> list[dict[str, Any]]:
    purge()
    now = _now()
    return [
        {
            "type": "ping_received",
            "from": r.responder_id,
            "to": r.pinger_id,
            "reverse_expires_at": r.expires_at,
        }
        for r in _reverse
        if r.pinger_id == user_id and r.expires_at > now
    ]


def try_send(
    *,
    from_id: str,
    to_id: str,
    is_online,
) -> tuple[str, ActivePing | None]:
    """Returns (result, ping). result: ok | target_online | already_active | forbidden."""
    purge()
    if from_id == to_id:
        return "forbidden", None
    if is_online(to_id):
        return "target_online", None
    key = (from_id, to_id)
    existing = _active.get(key)
    if existing:
        if existing.expires_at is None or existing.expires_at > _now():
            return "already_active", existing
        _active.pop(key, None)
    # Pinger must be online to send (they are — they issued WS).
    p = ActivePing(
        from_id=from_id,
        to_id=to_id,
        created_at=_now(),
        expires_at=None,
    )
    _active[key] = p
    return "ok", p


def try_receive(
    *,
    from_id: str,
    to_id: str,
    pinger_online: bool,
) -> tuple[str, ActivePing | None, ReverseNotify | None]:
    """B (to_id) receives ping from A (from_id).

    Returns (result, removed_ping, reverse_or_none).
    reverse is set when pinger was offline (store for later / delivery).
    """
    purge()
    key = (from_id, to_id)
    p = _active.get(key)
    if not p:
        return "not_found", None, None
    if p.expires_at is not None and p.expires_at <= _now():
        _active.pop(key, None)
        return "expired", None, None
    _active.pop(key, None)
    rev: ReverseNotify | None = None
    if not pinger_online:
        rev = ReverseNotify(
            pinger_id=from_id,
            responder_id=to_id,
            expires_at=_now() + REVERSE_NOTIFY_SEC,
        )
        # Replace older reverse from same responder+pinger pair
        _reverse[:] = [
            r
            for r in _reverse
            if not (r.pinger_id == from_id and r.responder_id == to_id)
        ]
        _reverse.append(rev)
    return "ok", p, rev


def try_ignore(*, from_id: str, to_id: str) -> str:
    """B dismisses UI; ping stays active. Always ok if exists."""
    purge()
    p = _active.get((from_id, to_id))
    if not p:
        return "not_found"
    return "ok"


def on_user_fully_offline(user_id: str) -> list[dict[str, Any]]:
    """Pinger fully offline → start 15m grace on their outgoing pings."""
    purge()
    now = _now()
    events: list[dict[str, Any]] = []
    for p in _active.values():
        if p.from_id != user_id:
            continue
        p.expires_at = now + OFFLINE_GRACE_SEC
        events.append(
            {
                "type": "ping",
                "from": p.from_id,
                "to": p.to_id,
                "created_at": p.created_at,
                "expires_at": p.expires_at,
                "status": "active",
            }
        )
    return events


def on_user_online(user_id: str) -> list[dict[str, Any]]:
    """Pinger back online → clear offline grace; deliver reverse notifies."""
    purge()
    events: list[dict[str, Any]] = []
    for p in _active.values():
        if p.from_id != user_id:
            continue
        if p.expires_at is not None:
            p.expires_at = None
            events.append(
                {
                    "type": "ping",
                    "from": p.from_id,
                    "to": p.to_id,
                    "created_at": p.created_at,
                    "expires_at": None,
                    "status": "active",
                }
            )
    # Deliver reverse notifies for this user as events (caller sends WS)
    for r in list(_reverse):
        if r.pinger_id == user_id and r.expires_at > _now():
            events.append(
                {
                    "type": "ping_received",
                    "from": r.responder_id,
                    "to": r.pinger_id,
                    "reverse_expires_at": r.expires_at,
                }
            )
            # One-time deliver on reconnect — remove so we don't re-spam every reconnect
            _reverse.remove(r)
    return events


def snapshot_message(user_id: str) -> dict[str, Any]:
    return {
        "type": "ping_state",
        "pings": list_for_user(user_id),
        "reverse": reverse_for_user(user_id),
    }
