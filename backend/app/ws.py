from __future__ import annotations

import json
from typing import Any

from fastapi import WebSocket

from app import users as user_store


class ConnectionManager:
    def __init__(self) -> None:
        # Multiple devices per account may be online at once.
        self.connections: dict[str, set[WebSocket]] = {}
        self.public_keys: dict[str, str] = {}

    def online_ids(self) -> set[str]:
        return {uid for uid, socks in self.connections.items() if socks}

    def is_online(self, user_id: str) -> bool:
        return bool(self.connections.get(user_id))

    def connection_count(self, user_id: str) -> int:
        return len(self.connections.get(user_id, ()))

    async def connect(self, user_id: str, websocket: WebSocket) -> None:
        await websocket.accept()
        bucket = self.connections.setdefault(user_id, set())
        bucket.add(websocket)

    def disconnect(self, user_id: str, websocket: WebSocket | None = None) -> bool:
        """Remove a socket. Returns True if the user is now fully offline."""
        bucket = self.connections.get(user_id)
        if not bucket:
            return False
        if websocket is not None:
            bucket.discard(websocket)
        else:
            bucket.clear()
        if bucket:
            return False
        self.connections.pop(user_id, None)
        self.public_keys.pop(user_id, None)
        return True

    def set_pubkey(self, user_id: str, pubkey: str) -> None:
        self.public_keys[user_id] = pubkey

    def get_pubkey(self, user_id: str) -> str | None:
        return self.public_keys.get(user_id)

    async def send_to(self, websocket: WebSocket, message: dict[str, Any]) -> bool:
        try:
            await websocket.send_text(json.dumps(message))
            return True
        except Exception:
            return False

    async def send_json(self, user_id: str, message: dict[str, Any]) -> bool:
        """Fan-out to every live device for this account. Returns True if any send ok."""
        bucket = self.connections.get(user_id)
        if not bucket:
            return False
        payload = json.dumps(message)
        dead: list[WebSocket] = []
        any_ok = False
        for ws in list(bucket):
            try:
                await ws.send_text(payload)
                any_ok = True
            except Exception:
                dead.append(ws)
        for ws in dead:
            bucket.discard(ws)
        if not bucket:
            self.connections.pop(user_id, None)
        return any_ok

    async def notify_presence_change(self, changed_user_id: str, online: bool) -> None:
        changed = user_store.get_user(changed_user_id)
        if not changed:
            return
        for viewer in user_store.all_users():
            if viewer.id == changed_user_id:
                continue
            if not user_store.allowed_edge(viewer.id, changed_user_id):
                continue
            if not self.is_online(viewer.id):
                continue
            await self.send_json(
                viewer.id,
                {
                    "type": "presence",
                    "from": changed_user_id,
                    "payload": None,
                    "user": {
                        "id": changed.id,
                        "username": changed.username,
                        "display_name": changed.display_name,
                        "role": changed.role,
                        "avatar_color": changed.avatar_color,
                        "online": online,
                    },
                },
            )

    async def send_presence_snapshot(
        self,
        viewer_id: str,
        websocket: WebSocket | None = None,
    ) -> None:
        """Send peer presence to one device (preferred) or all devices."""

        async def _emit(message: dict[str, Any]) -> None:
            if websocket is not None:
                await self.send_to(websocket, message)
            else:
                await self.send_json(viewer_id, message)

        peers = user_store.visible_peers(viewer_id)
        for peer in peers:
            await _emit(
                {
                    "type": "presence",
                    "from": peer.id,
                    "payload": None,
                    "user": {
                        "id": peer.id,
                        "username": peer.username,
                        "display_name": peer.display_name,
                        "role": peer.role,
                        "avatar_color": peer.avatar_color,
                        "online": self.is_online(peer.id),
                    },
                },
            )
            pubkey = self.get_pubkey(peer.id)
            if pubkey and self.is_online(peer.id):
                await _emit(
                    {
                        "type": "pubkey",
                        "from": peer.id,
                        "to": viewer_id,
                        "payload": pubkey,
                    },
                )

    async def fanout_pubkey(self, from_id: str, pubkey: str) -> None:
        self.set_pubkey(from_id, pubkey)
        for peer in user_store.visible_peers(from_id):
            if not self.is_online(peer.id):
                continue
            await self.send_json(
                peer.id,
                {
                    "type": "pubkey",
                    "from": from_id,
                    "to": peer.id,
                    "payload": pubkey,
                },
            )

    async def relay(
        self,
        *,
        msg_type: str,
        from_id: str,
        to_id: str,
        payload: str | None,
        msg_id: str | None = None,
    ) -> str:
        """Relay opaque payload. Returns 'ok' | 'forbidden' | 'undelivered'."""
        if not user_store.allowed_edge(from_id, to_id):
            return "forbidden"
        if not self.is_online(to_id):
            return "undelivered"
        message: dict[str, Any] = {
            "type": msg_type,
            "from": from_id,
            "to": to_id,
            "payload": payload,
        }
        if msg_id:
            message["msg_id"] = msg_id
        sent = await self.send_json(to_id, message)
        if not sent:
            return "undelivered"
        # Mirror to the sender's other devices so phone↔browser stay in sync.
        if msg_type in ("msg", "snap", "voice", "reaction", "profile"):
            await self.send_json(from_id, message)
        return "ok"


manager = ConnectionManager()
