from __future__ import annotations

import json
import secrets
from datetime import UTC, datetime

from app.config import settings
from app.models import InviteRecord

_invites: dict[str, InviteRecord] = {}


def load_invites() -> None:
    _invites.clear()
    path = settings.invites_path()
    if not path.is_file():
        return
    raw = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(raw, list):
        raise RuntimeError("Invites data must be a JSON array")
    for item in raw:
        inv = InviteRecord.model_validate(item)
        _invites[inv.code] = inv


def save_invites() -> None:
    path = settings.invites_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = [i.model_dump() for i in _invites.values()]
    path.write_text(
        json.dumps(payload, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )


def list_invites() -> list[InviteRecord]:
    return sorted(_invites.values(), key=lambda i: i.created_at, reverse=True)


def get_invite(code: str) -> InviteRecord | None:
    return _invites.get(code.strip())


def create_invite(*, created_by: str, label: str = "", max_uses: int = 1) -> InviteRecord:
    code = secrets.token_urlsafe(16)
    while code in _invites:
        code = secrets.token_urlsafe(16)
    inv = InviteRecord(
        code=code,
        label=label.strip(),
        max_uses=max_uses,
        uses=0,
        created_at=datetime.now(UTC).isoformat(),
        created_by=created_by,
        revoked=False,
    )
    _invites[code] = inv
    save_invites()
    return inv


def revoke_invite(code: str) -> InviteRecord | None:
    inv = _invites.get(code)
    if not inv:
        return None
    inv.revoked = True
    save_invites()
    return inv


def invite_is_redeemable(inv: InviteRecord) -> bool:
    if inv.revoked:
        return False
    return inv.uses < inv.max_uses


def consume_invite(code: str) -> InviteRecord:
    inv = _invites.get(code.strip())
    if not inv or not invite_is_redeemable(inv):
        raise ValueError("Invite invalid or already used")
    inv.uses += 1
    save_invites()
    return inv