from __future__ import annotations

import json
from pathlib import Path

from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError

from app.config import settings
from app.models import UserPublic, UserRecord

_ph = PasswordHasher()
_users_by_id: dict[str, UserRecord] = {}
_users_by_username: dict[str, UserRecord] = {}
_hub_id: str | None = None


def load_users(path: Path | None = None) -> None:
    global _hub_id
    if settings.users_json.strip():
        raw = json.loads(settings.users_json)
    else:
        users_path = path or settings.users_path()
        if not users_path.is_file():
            example = users_path.with_name("users.example.json")
            raise FileNotFoundError(
                f"Missing {users_path.name}. Copy {example.name} to "
                f"{users_path.name} for local use, or set USERS_JSON."
            )
        raw = json.loads(users_path.read_text(encoding="utf-8"))
    if not isinstance(raw, list):
        raise RuntimeError("Users data must be a JSON array")
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
