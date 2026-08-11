import { useCallback, useEffect, useRef, useState } from 'react'
import { wsUrl } from './api'
import {
  deleteAvatar,
  listAvatars,
  putAvatar,
  type AvatarRecord,
} from './avatarStore'
import {
  decryptPayload,
  deriveSessionKey,
  encryptPayload,
  newMsgId,
} from './crypto'
import { confirmPeerKey, observePeerKey } from './pinnedKeys'
import type {
  ChatMessage,
  MessageReplyTo,
  PlainPayload,
  PresencePing,
  ReversePingNotify,
  SnapTimerSec,
  UserPublic,
  WsIncoming,
} from './types'
import type { HubCallSignal } from './hooks/usePeerCall'
import { QUICK_REACTIONS } from './emojiData'
import { setOnlineFriendBadge } from './onlineBadge'
import { showLocalNotify } from './localNotify'

const REACTIONS = QUICK_REACTIONS

export type AvatarMap = Record<string, { version: string; imageB64: string }>

interface UsePresenceOptions {
  token: string
  myId: string
  privateKey: string
  publicKey: string
  /** Peer chat currently open; null = Friends list. Used for unread alerts. */
  activePeerId: string | null
}

function recordToMapEntry(r: AvatarRecord): { version: string; imageB64: string } {
  return { version: r.version, imageB64: r.imageB64 }
}

export function usePresenceSession(opts: UsePresenceOptions) {
  const { token, myId, privateKey, publicKey, activePeerId } = opts
  const [peers, setPeers] = useState<Record<string, UserPublic>>({})
  const [peerKeys, setPeerKeys] = useState<Record<string, string>>({})
  const [sessionKeys, setSessionKeys] = useState<Record<string, Uint8Array>>({})
  const [messages, setMessages] = useState<Record<string, ChatMessage[]>>({})
  const [typing, setTyping] = useState<Record<string, boolean>>({})
  const [unread, setUnread] = useState<Record<string, boolean>>({})
  const [avatars, setAvatars] = useState<AvatarMap>({})
  const [connected, setConnected] = useState(false)
  const [leavingPeer, setLeavingPeer] = useState<string | null>(null)
  const [fileTransfer, setFileTransfer] = useState<{
    peerId: string
    msgId: string
    name: string
    sent: number
    total: number
  } | null>(null)
  /** Outgoing A→peer (I am A). Key = peer id. */
  const [outgoingPings, setOutgoingPings] = useState<
    Record<string, PresencePing>
  >({})
  /** Incoming peer→me. Key = pinger id. */
  const [incomingPings, setIncomingPings] = useState<
    Record<string, PresencePing>
  >({})
  /** Reverse: peer received my ping while I was offline. Key = responder. */
  const [reverseNotifies, setReverseNotifies] = useState<
    Record<string, ReversePingNotify>
  >({})
  const [pingError, setPingError] = useState<string | null>(null)
  /** Local dismiss for Receive/Ignore UI this session. */
  const [ignoredPingFrom, setIgnoredPingFrom] = useState<Record<string, true>>(
    {},
  )
  /** Peer presented a different identity key than the one we pinned. */
  const [keyMismatches, setKeyMismatches] = useState<
    Record<string, { pinned: string; received: string }>
  >({})

  const wsRef = useRef<WebSocket | null>(null)
  const privateKeyRef = useRef(privateKey)
  const myIdRef = useRef(myId)
  const sessionKeysRef = useRef(sessionKeys)
  const peerKeysRef = useRef(peerKeys)
  const activePeerIdRef = useRef(activePeerId)
  const avatarsRef = useRef(avatars)
  const callHandlersRef = useRef(
    new Set<(from: string, signal: HubCallSignal) => void>(),
  )
  const fileAbortRef = useRef<{
    peerId: string
    msgId: string
    cancel: boolean
  } | null>(null)
  const fileBufRef = useRef(
    new Map<
      string,
      { chunks: (string | undefined)[]; meta: Extract<PlainPayload, { kind: 'file-meta' }>; peerId: string; from: string }
    >(),
  )
  privateKeyRef.current = privateKey
  sessionKeysRef.current = sessionKeys
  peerKeysRef.current = peerKeys
  activePeerIdRef.current = activePeerId
  avatarsRef.current = avatars
  myIdRef.current = myId
  const peersRef = useRef(peers)
  peersRef.current = peers

  // Hydrate cached avatars from IndexedDB
  useEffect(() => {
    let cancelled = false
    void listAvatars().then((rows) => {
      if (cancelled) return
      const next: AvatarMap = {}
      for (const r of rows) {
        next[r.userId] = recordToMapEntry(r)
      }
      setAvatars(next)
    })
    return () => {
      cancelled = true
    }
  }, [myId])

  // Opening a chat clears that peer's unread mark
  useEffect(() => {
    if (!activePeerId) return
    setUnread((prev) => {
      if (!prev[activePeerId]) return prev
      const next = { ...prev }
      delete next[activePeerId]
      return next
    })
  }, [activePeerId])

  // Tab title + app badge: how many friends are online (live session only)
  useEffect(() => {
    if (!connected) {
      void setOnlineFriendBadge(0)
      return () => {
        void setOnlineFriendBadge(0)
      }
    }
    const onlineCount = Object.values(peers).filter((p) => p.online).length
    void setOnlineFriendBadge(onlineCount)
    return () => {
      void setOnlineFriendBadge(0)
    }
  }, [connected, peers])

  const sendRaw = useCallback((data: Record<string, unknown>) => {
    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) return false
    ws.send(JSON.stringify(data))
    return true
  }, [])

  const pushProfileToPeer = useCallback(
    (peerId: string, key: Uint8Array) => {
      const self = avatarsRef.current[myIdRef.current]
      if (!self) return
      const payload = encryptPayload(key, {
        kind: 'profile',
        version: self.version,
        mime: 'image/jpeg',
        image_b64: self.imageB64,
      })
      sendRaw({ type: 'profile', to: peerId, payload })
    },
    [sendRaw],
  )

  useEffect(() => {
    const next: Record<string, Uint8Array> = {}
    for (const [peerId, pk] of Object.entries(peerKeys)) {
      try {
        next[peerId] = deriveSessionKey(privateKeyRef.current, pk)
      } catch {
        // ignore bad keys
      }
    }
    setSessionKeys(next)
  }, [peerKeys])

  // When a session key appears (or self avatar changes), share profile with peers
  const selfAvatar = avatars[myId]
  useEffect(() => {
    if (!selfAvatar) return
    for (const peerId of Object.keys(sessionKeys)) {
      pushProfileToPeer(peerId, sessionKeys[peerId])
    }
  }, [sessionKeys, selfAvatar, pushProfileToPeer])

  useEffect(() => {
    let closed = false
    let retryTimer: number | undefined
    let watchdogTimer: number | undefined
    let socket: WebSocket | null = null
    /** Last server transport heartbeat (`hb`). Missing ones → force reconnect. */
    let lastHbAt = 0
    const HB_STALE_MS = 55_000

    const connect = () => {
      if (closed) return
      if (watchdogTimer !== undefined) {
        window.clearInterval(watchdogTimer)
        watchdogTimer = undefined
      }
      const ws = new WebSocket(wsUrl(token))
      socket = ws
      wsRef.current = ws

      ws.onopen = () => {
        if (closed || wsRef.current !== ws) {
          ws.close()
          return
        }
        setConnected(true)
        lastHbAt = Date.now()
        ws.send(JSON.stringify({ type: 'pubkey', payload: publicKey }))
        // Detect silent NAT/proxy drops: TCP looks fine, but no `hb` arrives.
        watchdogTimer = window.setInterval(() => {
          if (wsRef.current !== ws || ws.readyState !== WebSocket.OPEN) return
          if (Date.now() - lastHbAt < HB_STALE_MS) return
          try {
            ws.close()
          } catch {
            /* onclose schedules reconnect */
          }
        }, 10_000)
      }

      ws.onclose = () => {
        if (wsRef.current !== ws) return
        wsRef.current = null
        setConnected(false)
        if (watchdogTimer !== undefined) {
          window.clearInterval(watchdogTimer)
          watchdogTimer = undefined
        }
        if (!closed) {
          retryTimer = window.setTimeout(connect, 1500)
        }
      }

      ws.onmessage = (ev) => {
        if (wsRef.current !== ws) return
        let data: WsIncoming
        try {
          data = JSON.parse(ev.data) as WsIncoming
        } catch {
          return
        }

        if (data.type === 'hb') {
          lastHbAt = Date.now()
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'hb_ack' }))
          }
          return
        }

        if (data.type === 'presence') {
          setPeers((prev) => ({ ...prev, [data.user.id]: data.user }))
          if (!data.user.online) {
            setPeerKeys((prev) => {
              const copy = { ...prev }
              delete copy[data.user.id]
              return copy
            })
            setUnread((prev) => {
              if (!prev[data.user.id]) return prev
              const copy = { ...prev }
              delete copy[data.user.id]
              return copy
            })
          }
          return
        }

        if (data.type === 'pubkey') {
          const observed = observePeerKey(data.from, data.payload)
          if (observed.status === 'mismatch') {
            setKeyMismatches((prev) => ({
              ...prev,
              [data.from]: {
                pinned: observed.pinned,
                received: observed.received,
              },
            }))
            // Keep using the pinned key until the user explicitly confirms.
            return
          }
          setKeyMismatches((prev) => {
            if (!prev[data.from]) return prev
            const copy = { ...prev }
            delete copy[data.from]
            return copy
          })
          setPeerKeys((prev) => ({ ...prev, [data.from]: data.payload }))
          return
        }

        if (data.type === 'peer_offline') {
          const peerId = data.from
          setLeavingPeer(peerId)
          setPeers((prev) => {
            const existing = prev[peerId]
            if (!existing) return prev
            return { ...prev, [peerId]: { ...existing, online: false } }
          })
          setPeerKeys((prev) => {
            const copy = { ...prev }
            delete copy[peerId]
            return copy
          })
          setTyping((prev) => {
            const copy = { ...prev }
            delete copy[peerId]
            return copy
          })
          setUnread((prev) => {
            if (!prev[peerId]) return prev
            const copy = { ...prev }
            delete copy[peerId]
            return copy
          })
          window.setTimeout(() => {
            setMessages((prev) => {
              const copy = { ...prev }
              delete copy[peerId]
              return copy
            })
            setLeavingPeer((cur) => (cur === peerId ? null : cur))
          }, 400)
          return
        }

        if (data.type === 'ack') {
          if (!data.msg_id) return
          const peerId = data.to
          setMessages((prev) => {
            const list = prev[peerId] ?? []
            return {
              ...prev,
              [peerId]: list.map((m) =>
                m.id === data.msg_id
                  ? {
                      ...m,
                      status:
                        data.payload === 'ok'
                          ? 'sent'
                          : data.payload === 'undelivered'
                            ? 'undelivered'
                            : 'failed',
                    }
                  : m,
              ),
            }
          })
          return
        }

        if (data.type === 'ping_state') {
          const out: Record<string, PresencePing> = {}
          const inn: Record<string, PresencePing> = {}
          const me = myIdRef.current
          for (const p of data.pings) {
            const row: PresencePing = {
              from: p.from,
              to: p.to,
              createdAt: p.created_at,
              expiresAt: p.expires_at,
            }
            if (p.from === me) out[p.to] = row
            if (p.to === me) inn[p.from] = row
          }
          setOutgoingPings(out)
          setIncomingPings(inn)
          const rev: Record<string, ReversePingNotify> = {}
          for (const r of data.reverse) {
            rev[r.from] = {
              from: r.from,
              expiresAt: r.reverse_expires_at,
            }
          }
          setReverseNotifies(rev)
          return
        }

        if (data.type === 'ping') {
          const me = myIdRef.current
          const row: PresencePing = {
            from: data.from,
            to: data.to,
            createdAt: data.created_at,
            expiresAt: data.expires_at,
          }
          if (data.from === me) {
            setOutgoingPings((prev) => ({ ...prev, [data.to]: row }))
          }
          if (data.to === me) {
            setIncomingPings((prev) => ({ ...prev, [data.from]: row }))
            setIgnoredPingFrom((prev) => {
              if (!prev[data.from]) return prev
              const next = { ...prev }
              delete next[data.from]
              return next
            })
            const name =
              peersRef.current[data.from]?.display_name ?? data.from
            void showLocalNotify(
              `${name} just pinged you`,
              'Open Presence to Receive or Ignore',
            )
          }
          return
        }

        if (data.type === 'ping_cleared') {
          const me = myIdRef.current
          if (data.from === me) {
            setOutgoingPings((prev) => {
              if (!prev[data.to]) return prev
              const next = { ...prev }
              delete next[data.to]
              return next
            })
          }
          if (data.to === me) {
            setIncomingPings((prev) => {
              if (!prev[data.from]) return prev
              const next = { ...prev }
              delete next[data.from]
              return next
            })
          }
          return
        }

        if (data.type === 'ping_received') {
          // Someone accepted my ping
          const until =
            data.reverse_expires_at ?? Date.now() / 1000 + 10 * 60
          setReverseNotifies((prev) => ({
            ...prev,
            [data.from]: { from: data.from, expiresAt: until },
          }))
          setOutgoingPings((prev) => {
            if (!prev[data.from]) return prev
            const next = { ...prev }
            delete next[data.from]
            return next
          })
          void showLocalNotify(
            'Ping received',
            `${peersRef.current[data.from]?.display_name ?? data.from} received your ping`,
          )
          return
        }

        if (data.type === 'ping_result') {
          if (data.result === 'ok') {
            setPingError(null)
            return
          }
          if (data.result === 'target_online') {
            setPingError('They are already online')
          } else if (data.result === 'already_active') {
            setPingError('You already pinged them — wait until it expires')
          } else if (data.result === 'forbidden') {
            setPingError('Cannot ping this user')
          } else if (data.result === 'not_found' || data.result === 'expired') {
            setPingError(null)
          } else {
            setPingError(data.result)
          }
          return
        }

        if (
          data.type === 'msg' ||
          data.type === 'typing' ||
          data.type === 'reaction' ||
          data.type === 'snap' ||
          data.type === 'voice' ||
          data.type === 'profile' ||
          data.type === 'call' ||
          data.type === 'file'
        ) {
          // Own-device echo: same ciphertext mirrored so phone↔browser stay in sync.
          const isEcho = data.from === myIdRef.current
          const peerId = isEcho ? data.to : data.from
          if (!peerId) return
          if (!data.payload) return
          let key = sessionKeysRef.current[peerId]
          if (!key) {
            const pk = peerKeysRef.current[peerId]
            if (!pk) return
            try {
              key = deriveSessionKey(privateKeyRef.current, pk)
            } catch {
              return
            }
          }
          const plain = decryptPayload(key, data.payload)
          if (!plain) return

          if (isEcho && (plain.kind === 'typing' || plain.kind === 'profile')) {
            return
          }

          if (plain.kind === 'msg') {
            setMessages((prev) => {
              const list = prev[peerId] ?? []
              if (list.some((m) => m.id === plain.msg_id)) return prev
              return {
                ...prev,
                [peerId]: [
                  ...list,
                  {
                    id: plain.msg_id,
                    from: isEcho ? myIdRef.current : peerId,
                    text: plain.text,
                    status: 'sent',
                    reactions: {},
                    kind: 'text',
                    reply_to: plain.reply_to,
                  },
                ],
              }
            })
            if (!isEcho && activePeerIdRef.current !== peerId) {
              setUnread((prev) =>
                prev[peerId] ? prev : { ...prev, [peerId]: true },
              )
            }
          } else if (plain.kind === 'sticker') {
            setMessages((prev) => {
              const list = prev[peerId] ?? []
              if (list.some((m) => m.id === plain.msg_id)) return prev
              return {
                ...prev,
                [peerId]: [
                  ...list,
                  {
                    id: plain.msg_id,
                    from: isEcho ? myIdRef.current : peerId,
                    text: '',
                    status: 'sent',
                    reactions: {},
                    kind: 'sticker',
                    image_b64: plain.image_b64,
                    sticker_mime: plain.mime,
                  },
                ],
              }
            })
            if (!isEcho && activePeerIdRef.current !== peerId) {
              setUnread((prev) =>
                prev[peerId] ? prev : { ...prev, [peerId]: true },
              )
            }
          } else if (plain.kind === 'snap') {
            setMessages((prev) => {
              const list = prev[peerId] ?? []
              if (list.some((m) => m.id === plain.msg_id)) return prev
              return {
                ...prev,
                [peerId]: [
                  ...list,
                  {
                    id: plain.msg_id,
                    from: isEcho ? myIdRef.current : peerId,
                    text: '',
                    status: 'sent',
                    reactions: {},
                    kind: 'snap',
                    timer_sec: plain.timer_sec,
                    opened: false,
                    image_b64: plain.image_b64,
                  },
                ],
              }
            })
            if (!isEcho && activePeerIdRef.current !== peerId) {
              setUnread((prev) =>
                prev[peerId] ? prev : { ...prev, [peerId]: true },
              )
            }
          } else if (plain.kind === 'voice') {
            setMessages((prev) => {
              const list = prev[peerId] ?? []
              if (list.some((m) => m.id === plain.msg_id)) return prev
              return {
                ...prev,
                [peerId]: [
                  ...list,
                  {
                    id: plain.msg_id,
                    from: isEcho ? myIdRef.current : peerId,
                    text: '',
                    status: 'sent',
                    reactions: {},
                    kind: 'voice',
                    audio_b64: plain.audio_b64,
                    audio_mime: plain.mime,
                    duration_ms: plain.duration_ms,
                  },
                ],
              }
            })
            if (!isEcho && activePeerIdRef.current !== peerId) {
              setUnread((prev) =>
                prev[peerId] ? prev : { ...prev, [peerId]: true },
              )
            }
          } else if (plain.kind === 'typing') {
            setTyping((prev) => ({ ...prev, [peerId]: plain.active }))
          } else if (plain.kind === 'reaction') {
            const reactorId = isEcho ? myIdRef.current : peerId
            setMessages((prev) => {
              const list = prev[peerId] ?? []
              return {
                ...prev,
                [peerId]: list.map((m) =>
                  m.id === plain.msg_id
                    ? {
                        ...m,
                        reactions: {
                          ...m.reactions,
                          [reactorId]: plain.emoji,
                        },
                      }
                    : m,
                ),
              }
            })
          } else if (plain.kind === 'profile') {
            if ('clear' in plain && plain.clear) {
              void deleteAvatar(peerId)
              setAvatars((prev) => {
                if (!prev[peerId]) return prev
                const next = { ...prev }
                delete next[peerId]
                return next
              })
              return
            }
            if (!('image_b64' in plain) || !plain.image_b64) return
            const existing = avatarsRef.current[peerId]
            if (existing && existing.version === plain.version) return
            const record: AvatarRecord = {
              userId: peerId,
              version: plain.version,
              mime: 'image/jpeg',
              imageB64: plain.image_b64,
              updatedAt: Date.now(),
            }
            void putAvatar(record)
            setAvatars((prev) => ({
              ...prev,
              [peerId]: recordToMapEntry(record),
            }))
          } else if (
            plain.kind === 'call-offer' ||
            plain.kind === 'call-answer' ||
            plain.kind === 'call-reject' ||
            plain.kind === 'call-end' ||
            plain.kind === 'webrtc-signal'
          ) {
            if (isEcho) return
            for (const h of callHandlersRef.current) {
              h(peerId, plain as HubCallSignal)
            }
          } else if (plain.kind === 'file-meta') {
            fileBufRef.current.set(plain.msg_id, {
              chunks: new Array(plain.totalChunks),
              meta: plain,
              peerId,
              from: isEcho ? myIdRef.current : peerId,
            })
            setMessages((prev) => {
              const list = prev[peerId] ?? []
              if (list.some((m) => m.id === plain.msg_id)) return prev
              return {
                ...prev,
                [peerId]: [
                  ...list,
                  {
                    id: plain.msg_id,
                    from: isEcho ? myIdRef.current : peerId,
                    text: `Receiving ${plain.name}…`,
                    status: 'sent',
                    reactions: {},
                    kind: 'file',
                    file_name: plain.name,
                    file_mime: plain.mime,
                    file_size: plain.size,
                  },
                ],
              }
            })
          } else if (plain.kind === 'file-chunk') {
            const buf = fileBufRef.current.get(plain.msg_id)
            if (buf) buf.chunks[plain.index] = plain.data_b64
          } else if (plain.kind === 'file-end') {
            const buf = fileBufRef.current.get(plain.msg_id)
            if (!buf) return
            fileBufRef.current.delete(plain.msg_id)
            if (buf.chunks.some((c) => !c)) {
              setMessages((prev) => ({
                ...prev,
                [peerId]: (prev[peerId] ?? []).map((m) =>
                  m.id === plain.msg_id
                    ? { ...m, text: `Failed: ${buf.meta.name}`, status: 'failed' }
                    : m,
                ),
              }))
              return
            }
            const dataB64 = buf.chunks.join('')
            setMessages((prev) => ({
              ...prev,
              [peerId]: (prev[peerId] ?? []).map((m) =>
                m.id === plain.msg_id
                  ? {
                      ...m,
                      text: buf.meta.name,
                      file_b64: dataB64,
                      file_name: buf.meta.name,
                      file_mime: buf.meta.mime,
                      file_size: buf.meta.size,
                      status: 'sent',
                    }
                  : m,
              ),
            }))
            if (!isEcho && activePeerIdRef.current !== peerId) {
              setUnread((prev) =>
                prev[peerId] ? prev : { ...prev, [peerId]: true },
              )
            }
          } else if (plain.kind === 'file-cancel') {
            fileBufRef.current.delete(plain.msg_id)
            setMessages((prev) => ({
              ...prev,
              [peerId]: (prev[peerId] ?? []).map((m) =>
                m.id === plain.msg_id
                  ? { ...m, text: 'Transfer cancelled', status: 'failed' }
                  : m,
              ),
            }))
          }
        }
      }
    }

    connect()

    return () => {
      closed = true
      if (retryTimer) window.clearTimeout(retryTimer)
      if (watchdogTimer !== undefined) {
        window.clearInterval(watchdogTimer)
        watchdogTimer = undefined
      }
      if (socket) {
        if (wsRef.current === socket) wsRef.current = null
        socket.close()
      }
    }
  }, [token, publicKey, sendRaw])

  const sendMessage = useCallback(
    (peerId: string, text: string, replyTo?: MessageReplyTo) => {
      const key = sessionKeys[peerId]
      if (!key) return
      const msg_id = newMsgId()
      const payload = encryptPayload(key, {
        kind: 'msg',
        text,
        msg_id,
        reply_to: replyTo,
      })
      const sent = sendRaw({ type: 'msg', to: peerId, payload, msg_id })
      setMessages((prev) => ({
        ...prev,
        [peerId]: [
          ...(prev[peerId] ?? []),
          {
            id: msg_id,
            from: myId,
            text,
            status: sent ? 'sending' : 'failed',
            reactions: {},
            kind: 'text',
            reply_to: replyTo,
          },
        ],
      }))
    },
    [sessionKeys, myId, sendRaw],
  )

  const sendSticker = useCallback(
    (peerId: string, imageB64: string, mime: string) => {
      const key = sessionKeys[peerId]
      if (!key) return
      const msg_id = newMsgId()
      const payload = encryptPayload(key, {
        kind: 'sticker',
        msg_id,
        mime,
        image_b64: imageB64,
      })
      const sent = sendRaw({ type: 'sticker', to: peerId, payload, msg_id })
      setMessages((prev) => ({
        ...prev,
        [peerId]: [
          ...(prev[peerId] ?? []),
          {
            id: msg_id,
            from: myId,
            text: '',
            status: sent ? 'sending' : 'failed',
            reactions: {},
            kind: 'sticker',
            image_b64: imageB64,
            sticker_mime: mime,
          },
        ],
      }))
    },
    [sessionKeys, myId, sendRaw],
  )

  const sendSnap = useCallback(
    (peerId: string, imageB64: string, timerSec: SnapTimerSec) => {
      const key = sessionKeys[peerId]
      if (!key) return
      const msg_id = newMsgId()
      const payload = encryptPayload(key, {
        kind: 'snap',
        msg_id,
        mime: 'image/jpeg',
        image_b64: imageB64,
        timer_sec: timerSec,
      })
      const sent = sendRaw({ type: 'snap', to: peerId, payload, msg_id })
      setMessages((prev) => ({
        ...prev,
        [peerId]: [
          ...(prev[peerId] ?? []),
          {
            id: msg_id,
            from: myId,
            text: '',
            status: sent ? 'sending' : 'failed',
            reactions: {},
            kind: 'snap',
            timer_sec: timerSec,
            opened: false,
          },
        ],
      }))
    },
    [sessionKeys, myId, sendRaw],
  )

  const sendVoice = useCallback(
    (
      peerId: string,
      audioB64: string,
      mime: string,
      durationMs: number,
    ) => {
      const key = sessionKeys[peerId]
      if (!key) return
      const msg_id = newMsgId()
      const payload = encryptPayload(key, {
        kind: 'voice',
        msg_id,
        mime,
        audio_b64: audioB64,
        duration_ms: durationMs,
      })
      const sent = sendRaw({ type: 'voice', to: peerId, payload, msg_id })
      setMessages((prev) => ({
        ...prev,
        [peerId]: [
          ...(prev[peerId] ?? []),
          {
            id: msg_id,
            from: myId,
            text: '',
            status: sent ? 'sending' : 'failed',
            reactions: {},
            kind: 'voice',
            audio_b64: audioB64,
            audio_mime: mime,
            duration_ms: durationMs,
          },
        ],
      }))
    },
    [sessionKeys, myId, sendRaw],
  )

  /** Wipe snap image bytes after view-once (or leave mid-view). */
  const consumeSnap = useCallback((peerId: string, msgId: string) => {
    setMessages((prev) => {
      const list = prev[peerId]
      if (!list) return prev
      return {
        ...prev,
        [peerId]: list.map((m) =>
          m.id === msgId && m.kind === 'snap'
            ? {
                ...m,
                opened: true,
                image_b64: undefined,
              }
            : m,
        ),
      }
    })
  }, [])

  const sendTyping = useCallback(
    (peerId: string, active: boolean) => {
      const key = sessionKeys[peerId]
      if (!key) return
      const payload = encryptPayload(key, { kind: 'typing', active })
      sendRaw({ type: 'typing', to: peerId, payload })
    },
    [sessionKeys, sendRaw],
  )

  const sendReaction = useCallback(
    (peerId: string, msgId: string, emoji: string) => {
      const key = sessionKeys[peerId]
      if (!key) return
      const payload = encryptPayload(key, {
        kind: 'reaction',
        msg_id: msgId,
        emoji,
      })
      setMessages((prev) => {
        const list = prev[peerId] ?? []
        return {
          ...prev,
          [peerId]: list.map((m) =>
            m.id === msgId
              ? { ...m, reactions: { ...m.reactions, [myId]: emoji } }
              : m,
          ),
        }
      })
      sendRaw({ type: 'reaction', to: peerId, payload, msg_id: msgId })
    },
    [sessionKeys, myId, sendRaw],
  )

  const setSelfAvatar = useCallback(
    async (imageB64: string) => {
      const version = `${Date.now()}`
      const record: AvatarRecord = {
        userId: myId,
        version,
        mime: 'image/jpeg',
        imageB64,
        updatedAt: Date.now(),
      }
      await putAvatar(record)
      setAvatars((prev) => ({
        ...prev,
        [myId]: recordToMapEntry(record),
      }))
      // Fan-out happens via the sessionKeys/avatars effect
    },
    [myId],
  )

  const clearSelfAvatar = useCallback(async () => {
    await deleteAvatar(myId)
    setAvatars((prev) => {
      if (!prev[myId]) return prev
      const next = { ...prev }
      delete next[myId]
      return next
    })
    for (const [peerId, key] of Object.entries(sessionKeysRef.current)) {
      const payload = encryptPayload(key, {
        kind: 'profile',
        version: `${Date.now()}`,
        clear: true,
      })
      sendRaw({ type: 'profile', to: peerId, payload })
    }
  }, [myId, sendRaw])

  const sendCallSignal = useCallback(
    (peerId: string, signal: HubCallSignal) => {
      const key = sessionKeysRef.current[peerId]
      if (!key) return false
      const payload = encryptPayload(key, signal)
      return sendRaw({ type: 'call', to: peerId, payload })
    },
    [sendRaw],
  )

  const onCallSignal = useCallback(
    (handler: (from: string, signal: HubCallSignal) => void) => {
      callHandlersRef.current.add(handler)
      return () => {
        callHandlersRef.current.delete(handler)
      }
    },
    [],
  )

  const FILE_CHUNK = 48_000
  const FILE_MAX = 2_500_000

  const cancelFile = useCallback(
    (peerId?: string) => {
      const cur = fileAbortRef.current
      if (!cur || cur.cancel) return
      if (peerId && cur.peerId !== peerId) return
      cur.cancel = true
      const key = sessionKeysRef.current[cur.peerId]
      if (key) {
        sendRaw({
          type: 'file',
          to: cur.peerId,
          payload: encryptPayload(key, {
            kind: 'file-cancel',
            msg_id: cur.msgId,
          }),
          msg_id: cur.msgId,
        })
      }
      setMessages((prev) => ({
        ...prev,
        [cur.peerId]: (prev[cur.peerId] ?? []).map((m) =>
          m.id === cur.msgId
            ? { ...m, text: 'Transfer cancelled', status: 'failed' }
            : m,
        ),
      }))
      setFileTransfer(null)
    },
    [sendRaw],
  )

  const sendFile = useCallback(
    async (peerId: string, file: File) => {
      const key = sessionKeys[peerId]
      if (!key) return
      if (file.size > FILE_MAX) {
        throw new Error('File too large (max ~2.5 MB while both online)')
      }
      if (fileAbortRef.current) {
        throw new Error('Another transfer is in progress')
      }
      const buf = new Uint8Array(await file.arrayBuffer())
      let binary = ''
      const step = 0x8000
      for (let i = 0; i < buf.length; i += step) {
        binary += Array.from(buf.subarray(i, i + step), (b) =>
          String.fromCharCode(b),
        ).join('')
      }
      const dataB64 = btoa(binary)
      const msg_id = newMsgId()
      const totalChunks = Math.ceil(dataB64.length / FILE_CHUNK) || 1
      const meta = {
        kind: 'file-meta' as const,
        msg_id,
        name: file.name.slice(0, 180),
        mime: file.type || 'application/octet-stream',
        size: file.size,
        totalChunks,
      }
      fileAbortRef.current = { peerId, msgId: msg_id, cancel: false }
      setFileTransfer({
        peerId,
        msgId: msg_id,
        name: file.name,
        sent: 0,
        total: totalChunks,
      })
      setMessages((prev) => ({
        ...prev,
        [peerId]: [
          ...(prev[peerId] ?? []),
          {
            id: msg_id,
            from: myId,
            text: `Sending ${file.name}…`,
            status: 'sending',
            reactions: {},
            kind: 'file',
            file_name: file.name,
            file_mime: file.type || 'application/octet-stream',
            file_size: file.size,
          },
        ],
      }))
      sendRaw({
        type: 'file',
        to: peerId,
        payload: encryptPayload(key, meta),
        msg_id,
      })
      for (let i = 0; i < totalChunks; i++) {
        const cur = fileAbortRef.current
        if (!cur || cur.msgId !== msg_id || cur.cancel) {
          fileAbortRef.current = null
          setFileTransfer(null)
          return
        }
        const piece = dataB64.slice(i * FILE_CHUNK, (i + 1) * FILE_CHUNK)
        sendRaw({
          type: 'file',
          to: peerId,
          payload: encryptPayload(key, {
            kind: 'file-chunk',
            msg_id,
            index: i,
            data_b64: piece,
          }),
          msg_id,
        })
        setFileTransfer({
          peerId,
          msgId: msg_id,
          name: file.name,
          sent: i + 1,
          total: totalChunks,
        })
        // Yield so Cancel can land between chunks.
        await new Promise((r) => setTimeout(r, 0))
      }
      const cur = fileAbortRef.current
      if (!cur || cur.msgId !== msg_id || cur.cancel) {
        fileAbortRef.current = null
        setFileTransfer(null)
        return
      }
      const sent = sendRaw({
        type: 'file',
        to: peerId,
        payload: encryptPayload(key, { kind: 'file-end', msg_id }),
        msg_id,
      })
      fileAbortRef.current = null
      setFileTransfer(null)
      setMessages((prev) => ({
        ...prev,
        [peerId]: (prev[peerId] ?? []).map((m) =>
          m.id === msg_id
            ? {
                ...m,
                text: file.name,
                status: sent ? 'sent' : 'failed',
                file_b64: dataB64,
              }
            : m,
        ),
      }))
    },
    [sessionKeys, myId, sendRaw],
  )

  const sendPing = useCallback(
    (peerId: string) => {
      setPingError(null)
      sendRaw({ type: 'ping_send', to: peerId })
    },
    [sendRaw],
  )

  const receivePing = useCallback(
    (fromId: string) => {
      sendRaw({ type: 'ping_receive', from: fromId })
      setIgnoredPingFrom((prev) => ({ ...prev, [fromId]: true }))
    },
    [sendRaw],
  )

  const ignorePing = useCallback(
    (fromId: string) => {
      sendRaw({ type: 'ping_ignore', from: fromId })
      setIgnoredPingFrom((prev) => ({ ...prev, [fromId]: true }))
    },
    [sendRaw],
  )

  const dismissReverseNotify = useCallback((fromId: string) => {
    setReverseNotifies((prev) => {
      if (!prev[fromId]) return prev
      const next = { ...prev }
      delete next[fromId]
      return next
    })
  }, [])

  // Drop reverse banners / pings when wall clock expires
  useEffect(() => {
    const t = window.setInterval(() => {
      const now = Date.now() / 1000
      setReverseNotifies((prev) => {
        let changed = false
        const next = { ...prev }
        for (const [k, v] of Object.entries(prev)) {
          if (v.expiresAt <= now) {
            delete next[k]
            changed = true
          }
        }
        return changed ? next : prev
      })
      setOutgoingPings((prev) => {
        let changed = false
        const next = { ...prev }
        for (const [k, v] of Object.entries(prev)) {
          if (v.expiresAt != null && v.expiresAt <= now) {
            delete next[k]
            changed = true
          }
        }
        return changed ? next : prev
      })
      setIncomingPings((prev) => {
        let changed = false
        const next = { ...prev }
        for (const [k, v] of Object.entries(prev)) {
          if (v.expiresAt != null && v.expiresAt <= now) {
            delete next[k]
            changed = true
          }
        }
        return changed ? next : prev
      })
    }, 15_000)
    return () => window.clearInterval(t)
  }, [])

  const confirmKeyChange = useCallback((peerId: string) => {
    const row = keyMismatches[peerId]
    if (!row) return
    confirmPeerKey(peerId, row.received)
    setPeerKeys((prev) => ({ ...prev, [peerId]: row.received }))
    setKeyMismatches((prev) => {
      const copy = { ...prev }
      delete copy[peerId]
      return copy
    })
  }, [keyMismatches])

  const peerList = Object.values(peers).sort((a, b) =>
    a.display_name.localeCompare(b.display_name),
  )

  return {
    connected,
    peers: peerList,
    peersById: peers,
    sessionKeys,
    keyMismatches,
    confirmKeyChange,
    messages,
    typing,
    unread,
    avatars,
    leavingPeer,
    sendMessage,
    sendSnap,
    sendVoice,
    sendSticker,
    sendFile,
    cancelFile,
    fileTransfer,
    sendCallSignal,
    onCallSignal,
    consumeSnap,
    sendTyping,
    sendReaction,
    setSelfAvatar,
    clearSelfAvatar,
    reactions: REACTIONS,
    outgoingPings,
    incomingPings,
    reverseNotifies,
    ignoredPingFrom,
    pingError,
    sendPing,
    receivePing,
    ignorePing,
    dismissReverseNotify,
  }
}
