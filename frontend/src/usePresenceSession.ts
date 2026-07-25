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
import type { ChatMessage, SnapTimerSec, UserPublic, WsIncoming } from './types'

const REACTIONS = ['👍', '❤️', '😂'] as const

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
  const [superseded, setSuperseded] = useState(false)
  const [leavingPeer, setLeavingPeer] = useState<string | null>(null)

  const wsRef = useRef<WebSocket | null>(null)
  const privateKeyRef = useRef(privateKey)
  const sessionKeysRef = useRef(sessionKeys)
  const peerKeysRef = useRef(peerKeys)
  const activePeerIdRef = useRef(activePeerId)
  const avatarsRef = useRef(avatars)
  const myIdRef = useRef(myId)
  privateKeyRef.current = privateKey
  sessionKeysRef.current = sessionKeys
  peerKeysRef.current = peerKeys
  activePeerIdRef.current = activePeerId
  avatarsRef.current = avatars
  myIdRef.current = myId

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

  // Tab title when something is waiting on Friends
  useEffect(() => {
    const count = Object.keys(unread).length
    document.title = count > 0 ? `(${count}) Presence` : 'Presence'
    return () => {
      document.title = 'Presence'
    }
  }, [unread])

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
    let socket: WebSocket | null = null

    const connect = () => {
      if (closed) return
      const ws = new WebSocket(wsUrl(token))
      socket = ws
      wsRef.current = ws

      ws.onopen = () => {
        if (closed || wsRef.current !== ws) {
          ws.close()
          return
        }
        setConnected(true)
        ws.send(JSON.stringify({ type: 'pubkey', payload: publicKey }))
      }

      // A superseded socket must not clear state owned by the current one
      ws.onclose = (ev) => {
        if (wsRef.current !== ws) return
        wsRef.current = null
        setConnected(false)
        // 4000 = server handed this account to another connection. Retrying
        // would kick that one back and ping-pong forever.
        if (ev.code === 4000) {
          setSuperseded(true)
          return
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

        if (
          data.type === 'msg' ||
          data.type === 'typing' ||
          data.type === 'reaction' ||
          data.type === 'snap' ||
          data.type === 'voice' ||
          data.type === 'profile'
        ) {
          const peerId = data.from
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
                    from: peerId,
                    text: plain.text,
                    status: 'sent',
                    reactions: {},
                    kind: 'text',
                  },
                ],
              }
            })
            if (activePeerIdRef.current !== peerId) {
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
                    from: peerId,
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
            if (activePeerIdRef.current !== peerId) {
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
                    from: peerId,
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
            if (activePeerIdRef.current !== peerId) {
              setUnread((prev) =>
                prev[peerId] ? prev : { ...prev, [peerId]: true },
              )
            }
          } else if (plain.kind === 'typing') {
            setTyping((prev) => ({ ...prev, [peerId]: plain.active }))
          } else if (plain.kind === 'reaction') {
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
                          [peerId]: plain.emoji,
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
          }
        }
      }
    }

    connect()

    return () => {
      closed = true
      if (retryTimer) window.clearTimeout(retryTimer)
      if (socket) {
        if (wsRef.current === socket) wsRef.current = null
        socket.close()
      }
    }
  }, [token, publicKey, sendRaw])

  const sendMessage = useCallback(
    (peerId: string, text: string) => {
      const key = sessionKeys[peerId]
      if (!key) return
      const msg_id = newMsgId()
      const payload = encryptPayload(key, { kind: 'msg', text, msg_id })
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

  const peerList = Object.values(peers).sort((a, b) =>
    a.display_name.localeCompare(b.display_name),
  )

  return {
    connected,
    superseded,
    peers: peerList,
    peersById: peers,
    sessionKeys,
    messages,
    typing,
    unread,
    avatars,
    leavingPeer,
    sendMessage,
    sendSnap,
    sendVoice,
    consumeSnap,
    sendTyping,
    sendReaction,
    setSelfAvatar,
    clearSelfAvatar,
    reactions: REACTIONS,
  }
}
