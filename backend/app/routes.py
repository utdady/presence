from __future__ import annotations

import json

from fastapi import APIRouter, Depends, HTTPException, WebSocket, WebSocketDisconnect, status

from app import users as user_store
from app.auth import create_access_token, require_user, user_from_token
from app.models import LoginRequest, TokenResponse, UserPublic, UserRecord
from app.ws import manager

router = APIRouter()


@router.post("/auth/login", response_model=TokenResponse)
def login(body: LoginRequest) -> TokenResponse:
    user = user_store.get_user_by_username(body.username)
    if not user or not user_store.verify_password(user, body.password):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid username or password",
        )
    token = create_access_token(user)
    return TokenResponse(
        access_token=token,
        user=user_store.to_public(user, online=manager.is_online(user.id)),
    )


@router.get("/me", response_model=UserPublic)
def me(user: UserRecord = Depends(require_user)) -> UserPublic:
    return user_store.to_public(user, online=manager.is_online(user.id))


@router.get("/peers", response_model=list[UserPublic])
def peers(user: UserRecord = Depends(require_user)) -> list[UserPublic]:
    return [
        user_store.to_public(p, online=manager.is_online(p.id))
        for p in user_store.visible_peers(user.id)
    ]


@router.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket, token: str | None = None) -> None:
    if not token:
        await websocket.close(code=4401, reason="Missing token")
        return
    try:
        user = user_from_token(token)
    except HTTPException:
        await websocket.close(code=4401, reason="Invalid token")
        return

    await manager.connect(user.id, websocket)
    await manager.send_presence_snapshot(user.id)
    await manager.notify_presence_change(user.id, online=True)

    try:
        while True:
            raw = await websocket.receive_text()
            try:
                data = json.loads(raw)
            except json.JSONDecodeError:
                await manager.send_json(
                    user.id,
                    {"type": "error", "payload": "invalid_json"},
                )
                continue

            msg_type = data.get("type")
            to_id = data.get("to")
            payload = data.get("payload")
            msg_id = data.get("msg_id")

            if msg_type == "pubkey":
                if not isinstance(payload, str) or not payload:
                    continue
                await manager.fanout_pubkey(user.id, payload)
                continue

            if msg_type in ("msg", "typing", "reaction", "snap", "voice", "profile"):
                if not isinstance(to_id, str):
                    await manager.send_json(
                        user.id,
                        {"type": "error", "payload": "missing_to"},
                    )
                    continue
                result = await manager.relay(
                    msg_type=msg_type,
                    from_id=user.id,
                    to_id=to_id,
                    payload=payload if isinstance(payload, str) else None,
                    msg_id=msg_id if isinstance(msg_id, str) else None,
                )
                if msg_type in ("msg", "snap", "voice"):
                    await manager.send_json(
                        user.id,
                        {
                            "type": "ack",
                            "to": to_id,
                            "msg_id": msg_id,
                            "payload": result,
                        },
                    )
                elif result == "forbidden":
                    await manager.send_json(
                        user.id,
                        {"type": "error", "payload": "forbidden"},
                    )
                continue

            await manager.send_json(
                user.id,
                {"type": "error", "payload": "unknown_type"},
            )
    except WebSocketDisconnect:
        pass
    finally:
        if manager.disconnect(user.id, websocket):
            await manager.notify_presence_change(user.id, online=False)
            # Notify peers that this user went offline (clear live threads)
            for peer in user_store.visible_peers(user.id):
                if manager.is_online(peer.id):
                    await manager.send_json(
                        peer.id,
                        {
                            "type": "peer_offline",
                            "from": user.id,
                            "to": peer.id,
                        },
                    )
