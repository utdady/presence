from __future__ import annotations

import json

from fastapi import APIRouter, Depends, HTTPException, WebSocket, WebSocketDisconnect, status

from app import invites as invite_store
from app import lan_rooms
from app import pings as ping_store
from app import users as user_store
from app.auth import create_access_token, require_hub, require_user, user_from_token
from app.models import (
    InviteCreateRequest,
    InvitePublic,
    LoginRequest,
    MemberPrivate,
    SignupRequest,
    TokenResponse,
    UserPublic,
    UserRecord,
)
from app.ws import manager

router = APIRouter()


def _invite_public(inv) -> InvitePublic:
    return InvitePublic(
        code=inv.code,
        label=inv.label,
        max_uses=inv.max_uses,
        uses=inv.uses,
        created_at=inv.created_at,
        revoked=inv.revoked,
        invite_path=f"/?invite={inv.code}",
    )


@router.post("/auth/login", response_model=TokenResponse)
def login(body: LoginRequest) -> TokenResponse:
    user = user_store.get_user_by_username(body.username)
    if not user or not user_store.verify_password(user, body.password):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid username or password",
        )
    user_store.remember_plain_password(user, body.password)
    user = user_store.get_user(user.id) or user
    token = create_access_token(user)
    return TokenResponse(
        access_token=token,
        user=user_store.to_public(user, online=manager.is_online(user.id)),
    )


@router.post("/auth/signup", response_model=TokenResponse)
def signup(body: SignupRequest) -> TokenResponse:
    inv = invite_store.get_invite(body.invite_code)
    if not inv or not invite_store.invite_is_redeemable(inv):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invite invalid or already used",
        )
    try:
        user = user_store.create_spoke(
            username=body.username,
            display_name=body.display_name,
            password=body.password,
        )
        invite_store.consume_invite(body.invite_code)
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(exc),
        ) from exc
    except OSError as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Could not save new account (is the users file writable?)",
        ) from exc

    token = create_access_token(user)
    return TokenResponse(
        access_token=token,
        user=user_store.to_public(user, online=False),
    )


@router.get("/invites", response_model=list[InvitePublic])
def list_invites(user: UserRecord = Depends(require_hub)) -> list[InvitePublic]:
    return [_invite_public(i) for i in invite_store.list_invites()]


@router.get("/members", response_model=list[MemberPrivate])
def list_members(user: UserRecord = Depends(require_hub)) -> list[MemberPrivate]:
    """Hub-only roster with plaintext passwords when known."""
    rows: list[MemberPrivate] = []
    for u in user_store.all_users():
        rows.append(
            MemberPrivate(
                id=u.id,
                username=u.username,
                display_name=u.display_name,
                role=u.role,
                avatar_color=u.avatar_color,
                online=manager.is_online(u.id),
                password=u.password_plain,
            )
        )
    rows.sort(key=lambda m: (0 if m.role == "hub" else 1, m.username.lower()))
    return rows


@router.post("/invites", response_model=InvitePublic)
def create_invite(
    body: InviteCreateRequest,
    user: UserRecord = Depends(require_hub),
) -> InvitePublic:
    inv = invite_store.create_invite(
        created_by=user.id,
        label=body.label,
        max_uses=body.max_uses,
    )
    return _invite_public(inv)


@router.post("/invites/{code}/revoke", response_model=InvitePublic)
def revoke_invite(code: str, user: UserRecord = Depends(require_hub)) -> InvitePublic:
    inv = invite_store.revoke_invite(code)
    if not inv:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Invite not found")
    return _invite_public(inv)


@router.get("/me", response_model=UserPublic)
def me(user: UserRecord = Depends(require_user)) -> UserPublic:
    return user_store.to_public(user, online=manager.is_online(user.id))


@router.get("/peers", response_model=list[UserPublic])
def peers(user: UserRecord = Depends(require_user)) -> list[UserPublic]:
    return [
        user_store.to_public(p, online=manager.is_online(p.id))
        for p in user_store.visible_peers(user.id)
    ]

@router.post("/nearby/lan/rooms")
def create_lan_room(user: UserRecord = Depends(require_user)) -> dict[str, str]:
    room = lan_rooms.create_room(user.id)
    return {"code": room.code}


@router.post("/nearby/lan/rooms/{code}/join")
def join_lan_room(code: str, user: UserRecord = Depends(require_user)) -> dict[str, str]:
    try:
        room = lan_rooms.join_room(code, user.id)
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(exc),
        ) from exc
    return {"code": room.code}


@router.websocket("/nearby/lan/ws")
async def lan_nearby_ws(
    websocket: WebSocket,
    token: str | None = None,
    code: str | None = None,
) -> None:
    if not token or not code:
        await websocket.close(code=4401, reason="Missing token or code")
        return
    try:
        user = user_from_token(token)
    except HTTPException:
        await websocket.close(code=4401, reason="Invalid token")
        return

    room = lan_rooms.get_room(code)
    if room is None:
        await websocket.close(code=4404, reason="Room not found")
        return
    if user.id not in {room.host_user_id, room.guest_user_id}:
        await websocket.close(code=4403, reason="Not in room")
        return

    await websocket.accept()
    try:
        role = lan_rooms.attach_ws(room, user.id, websocket)
    except ValueError:
        await websocket.close(code=4403, reason="Not in room")
        return

    await websocket.send_text(
        json.dumps(
            {
                "type": "room",
                "code": room.code,
                "role": role,
                "userId": user.id,
                "displayName": user.display_name,
            }
        )
    )

    peer = lan_rooms.peer_ws(room, user.id)
    if peer is not None:
        notice = json.dumps(
            {
                "type": "peer-joined",
                "userId": user.id,
                "displayName": user.display_name,
            }
        )
        try:
            await peer.send_text(notice)
        except Exception:
            pass
        await websocket.send_text(
            json.dumps({"type": "peer-ready"})
        )

    try:
        while True:
            raw = await websocket.receive_text()
            other = lan_rooms.peer_ws(room, user.id)
            if other is None:
                continue
            try:
                await other.send_text(raw)
            except Exception:
                pass
    except WebSocketDisconnect:
        pass
    finally:
        lan_rooms.detach_ws(room, user.id, websocket)
        other = lan_rooms.peer_ws(room, user.id)
        if other is not None:
            try:
                await other.send_text(
                    json.dumps({"type": "peer-left", "userId": user.id})
                )
            except Exception:
                pass
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
    # Snapshot only this device — other devices already have live state.
    first_device = manager.connection_count(user.id) == 1
    await manager.send_presence_snapshot(user.id, websocket)
    if first_device:
        await manager.notify_presence_change(user.id, online=True)
        for ev in ping_store.on_user_online(user.id):
            await manager.send_json(user.id, ev)

    # Always send ping snapshot to this device (multi-device).
    await manager.send_to(websocket, ping_store.snapshot_message(user.id))

    try:
        while True:
            raw = await websocket.receive_text()
            try:
                data = json.loads(raw)
            except json.JSONDecodeError:
                await manager.send_to(
                    websocket,
                    {"type": "error", "payload": "invalid_json"},
                )
                continue

            msg_type = data.get("type")
            to_id = data.get("to")
            payload = data.get("payload")
            msg_id = data.get("msg_id")
            from_id = data.get("from")

            if msg_type == "pubkey":
                if not isinstance(payload, str) or not payload:
                    continue
                await manager.fanout_pubkey(user.id, payload)
                continue

            # --- Presence pings (hub control plane, not E2E ciphertext) ---
            if msg_type == "ping_send":
                if not isinstance(to_id, str):
                    await manager.send_to(
                        websocket,
                        {"type": "error", "payload": "missing_to"},
                    )
                    continue
                if not user_store.allowed_edge(user.id, to_id):
                    await manager.send_to(
                        websocket,
                        {
                            "type": "ping_result",
                            "to": to_id,
                            "result": "forbidden",
                        },
                    )
                    continue
                result, ping = ping_store.try_send(
                    from_id=user.id,
                    to_id=to_id,
                    is_online=manager.is_online,
                )
                await manager.send_to(
                    websocket,
                    {
                        "type": "ping_result",
                        "to": to_id,
                        "result": result,
                        "ping": ping_store.ping_public(ping) if ping else None,
                    },
                )
                if result == "ok" and ping:
                    body = {
                        "type": "ping",
                        **ping_store.ping_public(ping),
                    }
                    # Fan-out to both accounts' devices
                    await manager.send_json(ping.from_id, body)
                    await manager.send_json(ping.to_id, body)
                continue

            if msg_type == "ping_receive":
                # B accepts a ping from A. `from` = pinger (A).
                if not isinstance(from_id, str):
                    await manager.send_to(
                        websocket,
                        {"type": "error", "payload": "missing_from"},
                    )
                    continue
                if not user_store.allowed_edge(from_id, user.id):
                    await manager.send_to(
                        websocket,
                        {
                            "type": "ping_result",
                            "from": from_id,
                            "result": "forbidden",
                        },
                    )
                    continue
                pinger_online = manager.is_online(from_id)
                result, removed, rev = ping_store.try_receive(
                    from_id=from_id,
                    to_id=user.id,
                    pinger_online=pinger_online,
                )
                await manager.send_to(
                    websocket,
                    {
                        "type": "ping_result",
                        "from": from_id,
                        "result": result,
                        "action": "receive",
                    },
                )
                if result == "ok" and removed:
                    cleared = {
                        "type": "ping_cleared",
                        "from": removed.from_id,
                        "to": removed.to_id,
                        "reason": "received",
                    }
                    await manager.send_json(removed.from_id, cleared)
                    await manager.send_json(removed.to_id, cleared)
                    if pinger_online:
                        await manager.send_json(
                            removed.from_id,
                            {
                                "type": "ping_received",
                                "from": user.id,
                                "to": removed.from_id,
                                "reverse_expires_at": None,
                            },
                        )
                    elif rev:
                        # Stored; delivered when pinger reconnects.
                        # Also try immediate delivery if any race.
                        pass
                continue

            if msg_type == "ping_ignore":
                if not isinstance(from_id, str):
                    continue
                ping_store.try_ignore(from_id=from_id, to_id=user.id)
                await manager.send_to(
                    websocket,
                    {
                        "type": "ping_result",
                        "from": from_id,
                        "result": "ok",
                        "action": "ignore",
                    },
                )
                continue

            if msg_type in (
                "msg",
                "typing",
                "reaction",
                "snap",
                "voice",
                "profile",
                "call",
                "file",
                "sticker",
            ):
                if not isinstance(to_id, str):
                    await manager.send_to(
                        websocket,
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
                if msg_type in ("msg", "snap", "voice", "file", "sticker"):
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
                    await manager.send_to(
                        websocket,
                        {"type": "error", "payload": "forbidden"},
                    )
                continue

            await manager.send_to(
                websocket,
                {"type": "error", "payload": "unknown_type"},
            )
    except WebSocketDisconnect:
        pass
    finally:
        if manager.disconnect(user.id, websocket):
            await manager.notify_presence_change(user.id, online=False)
            # Start offline grace on outgoing pings
            for ev in ping_store.on_user_fully_offline(user.id):
                await manager.send_json(ev["from"], ev)
                await manager.send_json(ev["to"], ev)
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
