"""Reply strategies for the Presence test dummy."""

from __future__ import annotations

import asyncio
from typing import Protocol

import httpx


class Replier(Protocol):
    async def reply(self, text: str) -> str: ...


class EchoReplier:
    async def reply(self, text: str) -> str:
        await asyncio.sleep(0.8)
        return f"echo: {text}"


class OllamaReplier:
    def __init__(
        self,
        *,
        base_url: str = "http://127.0.0.1:11434",
        model: str = "llama3.2",
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.model = model
        self._history: list[dict[str, str]] = [
            {
                "role": "system",
                "content": (
                    "You are Dummy, a brief test buddy on a presence-only chat app. "
                    "Reply in one or two short sentences. No markdown."
                ),
            }
        ]

    async def reply(self, text: str) -> str:
        self._history.append({"role": "user", "content": text})
        # Keep context short — presence chats are ephemeral anyway
        messages = [self._history[0], *self._history[1:][-8:]]
        async with httpx.AsyncClient(timeout=120.0) as client:
            res = await client.post(
                f"{self.base_url}/api/chat",
                json={
                    "model": self.model,
                    "messages": messages,
                    "stream": False,
                },
            )
            res.raise_for_status()
            content = res.json()["message"]["content"].strip()
        self._history.append({"role": "assistant", "content": content})
        return content
