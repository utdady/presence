#!/usr/bin/env python3
"""Presence spoke bot — echo (default) or Ollama-backed test dummy.

Usage:
  python main.py
  python main.py --mode ollama --model llama3.2
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import sys
from typing import Any

import httpx
import websockets
from websockets.exceptions import ConnectionClosed

from crypto_compat import (
    decrypt_payload,
    derive_session_key,
    encrypt_payload,
    load_or_create_identity,
    new_msg_id,
)
from replier import EchoReplier, OllamaReplier, Replier

log = logging.getLogger("presence-bot")


class PresenceBot:
    def __init__(
        self,
        *,
        api_base: str,
        username: str,
        password: str,
        replier: Replier,
    ) -> None:
        self.api_base = api_base.rstrip("/")
        self.username = username
        self.password = password
        self.replier = replier
        self.public_key, self.private_key = load_or_create_identity()
        self.my_id: str | None = None
        self.hub_id: str | None = None
        self.peer_pubkeys: dict[str, str] = {}
        self.session_keys: dict[str, bytes] = {}
        self._ws: Any = None
        self._typing_tasks: dict[str, asyncio.Task[None]] = {}

    async def login(self) -> str:
        async with httpx.AsyncClient(timeout=30.0) as client:
            res = await client.post(
                f"{self.api_base}/auth/login",
                json={"username": self.username, "password": self.password},
            )
            res.raise_for_status()
            data = res.json()
        self.my_id = data["user"]["id"]
        if data["user"]["role"] != "spoke":
            raise RuntimeError("Bot must log in as a spoke account")
        log.info("Logged in as %s (%s)", data["user"]["display_name"], self.my_id)
        return data["access_token"]

    def _ws_url(self, token: str) -> str:
        if self.api_base.startswith("https://"):
            base = "wss://" + self.api_base.removeprefix("https://")
        else:
            base = "ws://" + self.api_base.removeprefix("http://")
        return f"{base}/ws?token={token}"

    def _set_peer_key(self, peer_id: str, pubkey: str) -> None:
        self.peer_pubkeys[peer_id] = pubkey
        try:
            self.session_keys[peer_id] = derive_session_key(self.private_key, pubkey)
            log.info("Session key ready for %s", peer_id)
        except Exception:
            log.exception("Failed to derive session key for %s", peer_id)

    def _clear_peer(self, peer_id: str) -> None:
        self.peer_pubkeys.pop(peer_id, None)
        self.session_keys.pop(peer_id, None)
        task = self._typing_tasks.pop(peer_id, None)
        if task:
            task.cancel()

    async def _send(self, message: dict[str, Any]) -> None:
        if self._ws is None:
            return
        await self._ws.send(json.dumps(message))

    async def _send_typing(self, peer_id: str, active: bool) -> None:
        key = self.session_keys.get(peer_id)
        if not key:
            return
        payload = encrypt_payload(key, {"kind": "typing", "active": active})
        await self._send({"type": "typing", "to": peer_id, "payload": payload})

    async def _reply_flow(self, peer_id: str, text: str) -> None:
        key = self.session_keys.get(peer_id)
        if not key:
            log.warning("No session key for %s; cannot reply", peer_id)
            return
        await self._send_typing(peer_id, True)
        try:
            reply = await self.replier.reply(text)
        except Exception:
            log.exception("Replier failed")
            await self._send_typing(peer_id, False)
            return
        await self._send_typing(peer_id, False)
        # Key may have been cleared if peer went offline during generation
        key = self.session_keys.get(peer_id)
        if not key:
            log.info("Peer %s left before reply; dropping", peer_id)
            return
        msg_id = new_msg_id()
        payload = encrypt_payload(
            key, {"kind": "msg", "text": reply, "msg_id": msg_id}
        )
        await self._send(
            {"type": "msg", "to": peer_id, "payload": payload, "msg_id": msg_id}
        )
        log.info("→ %s: %s", peer_id, reply)

    async def _handle(self, data: dict[str, Any]) -> None:
        msg_type = data.get("type")

        if msg_type == "presence":
            user = data.get("user") or {}
            peer_id = user.get("id")
            if not peer_id or peer_id == self.my_id:
                return
            if user.get("role") == "hub":
                self.hub_id = peer_id
            online = bool(user.get("online"))
            log.info(
                "Presence %s (%s): %s",
                user.get("display_name"),
                peer_id,
                "online" if online else "offline",
            )
            if not online:
                self._clear_peer(peer_id)
            return

        if msg_type == "pubkey":
            peer_id = data.get("from")
            payload = data.get("payload")
            if isinstance(peer_id, str) and isinstance(payload, str):
                self._set_peer_key(peer_id, payload)
            return

        if msg_type == "peer_offline":
            peer_id = data.get("from")
            if isinstance(peer_id, str):
                log.info("Peer offline: %s", peer_id)
                self._clear_peer(peer_id)
            return

        if msg_type in ("msg", "typing", "reaction"):
            peer_id = data.get("from")
            payload = data.get("payload")
            if not isinstance(peer_id, str) or not isinstance(payload, str):
                return
            key = self.session_keys.get(peer_id)
            if not key:
                pk = self.peer_pubkeys.get(peer_id)
                if pk:
                    self._set_peer_key(peer_id, pk)
                    key = self.session_keys.get(peer_id)
            if not key:
                log.warning("Ciphertext from %s with no session key", peer_id)
                return
            plain = decrypt_payload(key, payload)
            if not plain:
                log.warning("Decrypt failed from %s", peer_id)
                return
            kind = plain.get("kind")
            if kind == "msg" and isinstance(plain.get("text"), str):
                log.info("← %s: %s", peer_id, plain["text"])
                # Cancel in-flight reply for this peer if any
                old = self._typing_tasks.pop(peer_id, None)
                if old:
                    old.cancel()
                self._typing_tasks[peer_id] = asyncio.create_task(
                    self._reply_flow(peer_id, plain["text"])
                )
            elif kind == "typing":
                log.debug("typing from %s: %s", peer_id, plain.get("active"))
            elif kind == "reaction":
                log.info(
                    "reaction from %s on %s: %s",
                    peer_id,
                    plain.get("msg_id"),
                    plain.get("emoji"),
                )
            return

        if msg_type == "ack":
            log.debug("ack %s", data.get("payload"))
            return

        if msg_type == "error":
            log.warning("server error: %s", data.get("payload"))

    async def run_forever(self) -> None:
        backoff = 1.0
        while True:
            try:
                token = await self.login()
                url = self._ws_url(token)
                log.info("Connecting %s", url.split("?")[0])
                async with websockets.connect(url) as ws:
                    self._ws = ws
                    backoff = 1.0
                    await self._send({"type": "pubkey", "payload": self.public_key})
                    async for raw in ws:
                        try:
                            data = json.loads(raw)
                        except json.JSONDecodeError:
                            continue
                        if isinstance(data, dict):
                            await self._handle(data)
            except ConnectionClosed as exc:
                log.warning("WS closed: %s", exc)
            except httpx.HTTPError as exc:
                log.error("HTTP error: %s", exc)
            except Exception:
                log.exception("Bot loop error")
            finally:
                self._ws = None
                self.session_keys.clear()
                self.peer_pubkeys.clear()
            log.info("Reconnect in %.0fs…", backoff)
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, 15.0)


def build_replier(args: argparse.Namespace) -> Replier:
    if args.mode == "ollama":
        return OllamaReplier(base_url=args.ollama_url, model=args.model)
    return EchoReplier()


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Presence test dummy (spoke client)")
    p.add_argument("--api", default="http://127.0.0.1:8000", help="Backend HTTP base URL")
    p.add_argument("--username", default="dummy")
    p.add_argument("--password", default="dummy-pass-change-me")
    p.add_argument("--mode", choices=("echo", "ollama"), default="echo")
    p.add_argument("--ollama-url", default="http://127.0.0.1:11434")
    p.add_argument("--model", default="llama3.2", help="Ollama model name")
    p.add_argument("-v", "--verbose", action="store_true")
    return p.parse_args(argv)


async def amain(argv: list[str] | None = None) -> None:
    args = parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
        datefmt="%H:%M:%S",
    )
    bot = PresenceBot(
        api_base=args.api,
        username=args.username,
        password=args.password,
        replier=build_replier(args),
    )
    log.info("Mode=%s identity=%s…", args.mode, bot.public_key[:12])
    await bot.run_forever()


def main() -> None:
    try:
        asyncio.run(amain())
    except KeyboardInterrupt:
        print("\nbye", file=sys.stderr)


if __name__ == "__main__":
    main()
