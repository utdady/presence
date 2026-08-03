from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field


Role = Literal["hub", "spoke"]


class UserRecord(BaseModel):
    id: str
    username: str
    display_name: str
    password_hash: str
    role: Role
    avatar_color: str


class UserPublic(BaseModel):
    id: str
    username: str
    display_name: str
    role: Role
    avatar_color: str
    online: bool = False


class LoginRequest(BaseModel):
    username: str
    password: str


class SignupRequest(BaseModel):
    invite_code: str
    username: str = Field(min_length=2, max_length=32)
    display_name: str = Field(min_length=1, max_length=64)
    password: str = Field(min_length=8, max_length=128)


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: UserPublic


class InviteCreateRequest(BaseModel):
    label: str = Field(default="", max_length=64)
    # Optional max uses; default 1 = single-use invite
    max_uses: int = Field(default=1, ge=1, le=50)


class InvitePublic(BaseModel):
    code: str
    label: str
    max_uses: int
    uses: int
    created_at: str
    revoked: bool = False
    invite_path: str


class InviteRecord(BaseModel):
    code: str
    label: str = ""
    max_uses: int = 1
    uses: int = 0
    created_at: str
    created_by: str
    revoked: bool = False


class WsEnvelope(BaseModel):
    type: str
    from_id: str | None = Field(default=None, alias="from")
    to_id: str | None = Field(default=None, alias="to")
    payload: str | None = None
    msg_id: str | None = None

    model_config = {"populate_by_name": True}