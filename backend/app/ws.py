from __future__ import annotations

import json
from typing import Any

from fastapi import WebSocket

from app import users as user_store


class ConnectionManager:
    def __init__(self) -> None:
        self.connections: dict[str, WebSocket] = {}
        self.public_keys: dict[str, str] = {}

    def online_ids(self) -> set[str]:
        return set(self.connections.keys())

    def is_online(self, user_id: str) -> bool:
        return user_id in self.connections

    async def connect(self, user_id: str, websocket: WebSocket) -> None:
        await websocket.accept()
        old = self.connections.get(user_id)
        if old is not None and old is not websocket:
            try:
                await old.close(code=4000, reason="Replaced by new connection")
            except Exception:
                pass
        self.connections[user_id] = websocket

    def disconnect(self, user_id: str, websocket: WebSocket | None = None) -> bool:
        current = self.connections.get(user_id)
        if current is None:
            return False
        if websocket is not None and current is not websocket:
            return False
        self.connections.pop(user_id, None)
        self.public_keys.pop(user_id, None)
        return True

    def set_pubkey(self, user_id: str, pubkey: str) -> None:
        self.public_keys[user_id] = pubkey

    def get_pubkey(self, user_id: str) -> str | None:
        return self.public_keys.get(user_id)

    async def send_json(self, user_id: str, message: dict[str, Any]) -> bool:
        ws = self.connections.get(user_id)
        if ws is None:
            return False
        try:
            await ws.send_text(json.dumps(message))
            return True
        except Exception:
            return False

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

    async def send_presence_snapshot(self, viewer_id: str) -> None:
        peers = user_store.visible_peers(viewer_id)
        for peer in peers:
            await self.send_json(
                viewer_id,
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
                await self.send_json(
                    viewer_id,
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
        return "ok" if sent else "undelivered"


manager = ConnectionManager()
