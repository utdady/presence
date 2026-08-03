from __future__ import annotations

import json
import re
import secrets
from pathlib import Path

from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError

from app.config import settings
from app.models import UserPublic, UserRecord

_ph = PasswordHasher()
_users_by_id: dict[str, UserRecord] = {}
_users_by_username: dict[str, UserRecord] = {}
_hub_id: str | None = None

_AVATAR_COLORS = (
    "#6B7C8A",
    "#7A8B6F",
    "#5C6B7A",
    "#8A7A6B",
    "#6F7A8B",
    "#7A6B8A",
)


def load_users(path: Path | None = None) -> None:
    global _hub_id
    users_path = path or settings.users_path()
    raw: list | None = None

    # Prefer on-disk roster when present so invite signups persist across restarts.
    if users_path.is_file():
        loaded = json.loads(users_path.read_text(encoding="utf-8"))
        if isinstance(loaded, list):
            raw = loaded
    if raw is None and settings.users_json.strip():
        loaded = json.loads(settings.users_json)
        if not isinstance(loaded, list):
            raise RuntimeError("USERS_JSON must be a JSON array")
        raw = loaded
        # Seed file when possible so later saves have a home.
        try:
            users_path.parent.mkdir(parents=True, exist_ok=True)
            users_path.write_text(
                json.dumps(raw, indent=2, ensure_ascii=False) + "\n",
                encoding="utf-8",
            )
        except OSError:
            pass
    if raw is None:
        example = users_path.with_name("users.example.json")
        raise FileNotFoundError(
            f"Missing {users_path.name}. Copy {example.name} to "
            f"{users_path.name} for local use, or set USERS_JSON."
        )

    _users_by_id.clear()
    _users_by_username.clear()
    hub_count = 0
    for item in raw:
        user = UserRecord.model_validate(item)
        _users_by_id[user.id] = user
        _users_by_username[user.username.lower()] = user
        if user.role == "hub":
            hub_count += 1
            _hub_id = user.id
    if hub_count != 1:
        raise RuntimeError(f"Expected exactly one hub user, found {hub_count}")


def save_users() -> None:
    path = settings.users_path()
    payload = [u.model_dump() for u in all_users()]
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(payload, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )


def get_user(user_id: str) -> UserRecord | None:
    return _users_by_id.get(user_id)


def get_user_by_username(username: str) -> UserRecord | None:
    return _users_by_username.get(username.lower())


def hub_id() -> str:
    if _hub_id is None:
        raise RuntimeError("Users not loaded")
    return _hub_id


def verify_password(user: UserRecord, password: str) -> bool:
    try:
        return _ph.verify(user.password_hash, password)
    except VerifyMismatchError:
        return False


def hash_password(password: str) -> str:
    return _ph.hash(password)


def to_public(user: UserRecord, online: bool = False) -> UserPublic:
    return UserPublic(
        id=user.id,
        username=user.username,
        display_name=user.display_name,
        role=user.role,
        avatar_color=user.avatar_color,
        online=online,
    )


def all_users() -> list[UserRecord]:
    return list(_users_by_id.values())


def allowed_edge(a: str, b: str) -> bool:
    """True iff one is hub and the other is a spoke."""
    if a == b:
        return False
    ua, ub = get_user(a), get_user(b)
    if not ua or not ub:
        return False
    roles = {ua.role, ub.role}
    return roles == {"hub", "spoke"}


def visible_peers(viewer_id: str) -> list[UserRecord]:
    viewer = get_user(viewer_id)
    if not viewer:
        return []
    if viewer.role == "hub":
        return [u for u in all_users() if u.role == "spoke"]
    return [u for u in all_users() if u.role == "hub"]


def _slug_id(username: str) -> str:
    base = re.sub(r"[^a-z0-9]+", "", username.lower())
    if not base:
        base = "user"
    candidate = base
    while candidate in _users_by_id:
        candidate = f"{base}-{secrets.token_hex(2)}"
    return candidate


def create_spoke(
    *,
    username: str,
    display_name: str,
    password: str,
) -> UserRecord:
    uname = username.strip()
    if not uname or get_user_by_username(uname):
        raise ValueError("Username unavailable")
    if not re.fullmatch(r"[A-Za-z0-9_\.]{2,32}", uname):
        raise ValueError(
            "Username must be 2–32 chars: letters, numbers, _ or ."
        )
    user = UserRecord(
        id=_slug_id(uname),
        username=uname,
        display_name=display_name.strip() or uname,
        password_hash=hash_password(password),
        role="spoke",
        avatar_color=secrets.choice(_AVATAR_COLORS),
    )
    _users_by_id[user.id] = user
    _users_by_username[user.username.lower()] = user
    save_users()
    return user