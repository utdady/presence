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


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: UserPublic


class WsEnvelope(BaseModel):
    type: str
    from_id: str | None = Field(default=None, alias="from")
    to_id: str | None = Field(default=None, alias="to")
    payload: str | None = None
    msg_id: str | None = None

    model_config = {"populate_by_name": True}
