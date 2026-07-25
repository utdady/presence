"""Crypto matching frontend/src/crypto.ts (libsodium-wrappers)."""

from __future__ import annotations

import base64
import json
import secrets
from pathlib import Path
from typing import Any

from nacl.bindings import (
    crypto_aead_chacha20poly1305_ietf_decrypt,
    crypto_aead_chacha20poly1305_ietf_encrypt,
    crypto_box_beforenm,
    crypto_box_keypair,
)
from nacl.encoding import RawEncoder
from nacl.hash import blake2b

NONCE_BYTES = 12
SESSION_HASH_KEY = b"presence-v0-session"
KEY_FILE = Path(__file__).resolve().parent / "identity_key.json"


def b64_encode(data: bytes) -> str:
    return base64.b64encode(data).decode("ascii")


def b64_decode(data: str) -> bytes:
    return base64.b64decode(data)


def load_or_create_identity(path: Path = KEY_FILE) -> tuple[str, str]:
    if path.exists():
        raw = json.loads(path.read_text(encoding="utf-8"))
        return raw["publicKey"], raw["privateKey"]
    pk, sk = crypto_box_keypair()
    record = {"publicKey": b64_encode(pk), "privateKey": b64_encode(sk)}
    path.write_text(json.dumps(record, indent=2), encoding="utf-8")
    return record["publicKey"], record["privateKey"]


def derive_session_key(my_private_b64: str, peer_public_b64: str) -> bytes:
    shared = crypto_box_beforenm(b64_decode(peer_public_b64), b64_decode(my_private_b64))
    # Matches sodium.crypto_generichash(32, shared, key=b"presence-v0-session")
    return blake2b(shared, digest_size=32, key=SESSION_HASH_KEY, encoder=RawEncoder)


def encrypt_payload(session_key: bytes, plain: dict[str, Any]) -> str:
    nonce = secrets.token_bytes(NONCE_BYTES)
    message = json.dumps(plain, separators=(",", ":")).encode("utf-8")
    cipher = crypto_aead_chacha20poly1305_ietf_encrypt(message, None, nonce, session_key)
    return b64_encode(nonce + cipher)


def decrypt_payload(session_key: bytes, payload_b64: str) -> dict[str, Any] | None:
    try:
        packed = b64_decode(payload_b64)
        nonce = packed[:NONCE_BYTES]
        cipher = packed[NONCE_BYTES:]
        message = crypto_aead_chacha20poly1305_ietf_decrypt(cipher, None, nonce, session_key)
        return json.loads(message.decode("utf-8"))
    except Exception:
        return None


def new_msg_id() -> str:
    return b64_encode(secrets.token_bytes(12))
