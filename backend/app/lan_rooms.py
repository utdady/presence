"""Short-lived internet rooms for in-person Nearby fallback.

Intentional product exception: any two authenticated users may share a room —
this path does NOT enforce hub↔spoke `allowed_edge()`. Physically-present /
code-shared trust is treated as distinct from the invite-gated hub roster.
Bluetooth Nearby remains the fully offline path; this module always needs the
server for the room code + signaling WebSocket.
"""

from __future__ import annotations

import secrets
import string
import time
from dataclasses import dataclass, field

from fastapi import WebSocket

_CODE_ALPHABET = string.ascii_uppercase + string.digits
_ROOM_TTL_SEC = 60 * 30


@dataclass
class LanRoom:
    code: str
    host_user_id: str
    created_at: float = field(default_factory=time.time)
    guest_user_id: str | None = None
    host_ws: WebSocket | None = None
    guest_ws: WebSocket | None = None


_rooms: dict[str, LanRoom] = {}


def _purge_expired() -> None:
    now = time.time()
    dead = [c for c, r in _rooms.items() if now - r.created_at > _ROOM_TTL_SEC]
    for c in dead:
        _rooms.pop(c, None)


def _new_code() -> str:
    while True:
        code = "".join(secrets.choice(_CODE_ALPHABET) for _ in range(6))
        if code not in _rooms:
            return code


def create_room(host_user_id: str) -> LanRoom:
    _purge_expired()
    room = LanRoom(code=_new_code(), host_user_id=host_user_id)
    _rooms[room.code] = room
    return room


def get_room(code: str) -> LanRoom | None:
    _purge_expired()
    return _rooms.get(code.strip().upper())


def join_room(code: str, guest_user_id: str) -> LanRoom:
    room = get_room(code)
    if room is None:
        raise ValueError("Room not found or expired")
    if room.guest_user_id and room.guest_user_id != guest_user_id:
        raise ValueError("Room is full")
    if guest_user_id == room.host_user_id:
        raise ValueError("Cannot join your own room")
    room.guest_user_id = guest_user_id
    return room


def attach_ws(room: LanRoom, user_id: str, ws: WebSocket) -> str:
    """Attach socket; returns role 'host' or 'guest'."""
    if user_id == room.host_user_id:
        room.host_ws = ws
        return "host"
    if user_id == room.guest_user_id:
        room.guest_ws = ws
        return "guest"
    raise ValueError("Not a member of this room")


def peer_ws(room: LanRoom, user_id: str) -> WebSocket | None:
    if user_id == room.host_user_id:
        return room.guest_ws
    if user_id == room.guest_user_id:
        return room.host_ws
    return None


def detach_ws(room: LanRoom, user_id: str, ws: WebSocket) -> None:
    if user_id == room.host_user_id and room.host_ws is ws:
        room.host_ws = None
    if user_id == room.guest_user_id and room.guest_ws is ws:
        room.guest_ws = None
    # Drop empty rooms
    if room.host_ws is None and room.guest_ws is None:
        _rooms.pop(room.code, None)