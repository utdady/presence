import { useCallback, useEffect, useRef, useState } from 'react'
import {
  deriveSessionKey,
  encryptJson,
  decryptJson,
  handshakeConfirmDigest,
  keyFingerprint,
  randomHandshakeNonce,
} from '../crypto'
import {
  confirmPeerKey,
  nearbyPinStatus,
  type NearbyPinStatus,
} from '../pinnedKeys'
import { getToken, apiUrl, PROD_ORIGIN, isPackedClient } from '../api'
import type {
  NearbyCallPhase,
  NearbyChatMessage,
  NearbyHello,
  NearbyPlainSignal,
  NearbyWire,
} from './types'

export interface UseLanNearbyCallOptions {
  userId: string
  displayName: string
  publicKey: string
  privateKey: string
}

function lanWsUrl(code: string, token: string): string {
  if (isPackedClient()) {
    const u = new URL(PROD_ORIGIN)
    const proto = u.protocol === 'https:' ? 'wss:' : 'ws:'
    return `${proto}//${u.host}/nearby/lan/ws?token=${encodeURIComponent(token)}&code=${encodeURIComponent(code)}`
  }
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${window.location.host}/nearby/lan/ws?token=${encodeURIComponent(token)}&code=${encodeURIComponent(code)}`
}

export function useLanNearbyCall(opts: UseLanNearbyCallOptions) {
  const [phase, setPhase] = useState<NearbyCallPhase>('idle')
  const [roomCode, setRoomCode] = useState<string | null>(null)
  const [remoteName, setRemoteName] = useState<string | null>(null)
  const [remoteFingerprint, setRemoteFingerprint] = useState<string | null>(null)
  const [pinStatus, setPinStatus] = useState<NearbyPinStatus | null>(null)
  const [muted, setMuted] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState('')
  const [messages, setMessages] = useState<NearbyChatMessage[]>([])

  const sessionKeyRef = useRef<Uint8Array | null>(null)
  const localNonceRef = useRef<string | null>(null)
  const remoteNonceRef = useRef<string | null>(null)
  const confirmOkRef = useRef(false)
  const confirmSentRef = useRef(false)
  const pendingPeerRef = useRef<{
    userId: string
    displayName: string
    publicKey: string
  } | null>(null)
  const pcRef = useRef<RTCPeerConnection | null>(null)
  const localStreamRef = useRef<MediaStream | null>(null)
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const makingOfferRef = useRef(false)
  const politeRef = useRef(false)
  const ignoreOfferRef = useRef(false)
  const optsRef = useRef(opts)
  optsRef.current = opts
  const mediaGenRef = useRef(0)
  const phaseRef = useRef<NearbyCallPhase>('idle')
  phaseRef.current = phase

  const cleanupMedia = useCallback(() => {
    mediaGenRef.current += 1
    pcRef.current?.close()
    pcRef.current = null
    localStreamRef.current?.getTracks().forEach((t) => t.stop())
    localStreamRef.current = null
    if (remoteAudioRef.current) remoteAudioRef.current.srcObject = null
    makingOfferRef.current = false
    ignoreOfferRef.current = false
  }, [])

  const sendRaw = useCallback((wire: NearbyWire) => {
    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new Error('Not connected to room')
    }
    ws.send(JSON.stringify({ type: 'relay', payload: wire }))
  }, [])

  const sendSignal = useCallback(
    (signal: NearbyPlainSignal) => {
      const key = sessionKeyRef.current
      if (!key) throw new Error('No session key')
      sendRaw({ type: 'enc', payload: encryptJson(key, signal) })
    },
    [sendRaw],
  )

  const resetHandshake = useCallback(() => {
    localNonceRef.current = null
    remoteNonceRef.current = null
    confirmOkRef.current = false
    confirmSentRef.current = false
    pendingPeerRef.current = null
    setPinStatus(null)
  }, [])

  const tryUnlockSession = useCallback(() => {
    const pending = pendingPeerRef.current
    const key = sessionKeyRef.current
    if (!pending || !key) return
    const local = localNonceRef.current
    const remote = remoteNonceRef.current
    if (remote) {
      if (!local || !confirmOkRef.current) return
    }
    const status = nearbyPinStatus(pending.userId, pending.publicKey)
    setPinStatus(status)
    setRemoteName(pending.displayName)
    setRemoteFingerprint(keyFingerprint(pending.publicKey))
    if (status === 'known') {
      setPhase('ready')
      setStatus(`Connected to ${pending.displayName} · known key`)
      return
    }
    setPhase('verify')
    setStatus(
      status === 'changed'
        ? 'Key changed — compare fingerprints, then confirm'
        : 'Compare fingerprints on both screens, then confirm',
    )
  }, [])

  const trySendKeyConfirm = useCallback(() => {
    const key = sessionKeyRef.current
    const local = localNonceRef.current
    const remote = remoteNonceRef.current
    if (!key || !local || !remote || confirmSentRef.current) return
    confirmSentRef.current = true
    try {
      sendSignal({
        type: 'key-confirm',
        digest: handshakeConfirmDigest(local, remote),
      })
    } catch {
      confirmSentRef.current = false
    }
  }, [sendSignal])

  const ensurePc = useCallback(async () => {
    if (pcRef.current) return pcRef.current
    const pc = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
    })
    pcRef.current = pc
    pc.onicecandidate = (ev) => {
      if (!ev.candidate) return
      try {
        sendSignal({
          type: 'webrtc-signal',
          signal: ev.candidate.toJSON(),
        })
      } catch {
        /* ignore */
      }
    }
    pc.ontrack = (ev) => {
      const audio = remoteAudioRef.current
      if (!audio) return
      audio.srcObject = ev.streams[0] ?? new MediaStream([ev.track])
      void audio.play().catch(() => {})
    }
    const gen = (mediaGenRef.current += 1)
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: false,
    })
    if (gen !== mediaGenRef.current) {
      stream.getTracks().forEach((t) => t.stop())
      return pc
    }
    localStreamRef.current = stream
    for (const track of stream.getTracks()) {
      pc.addTrack(track, stream)
    }
    return pc
  }, [sendSignal])

  const sendHello = useCallback(() => {
    // Keep a stable nonce for this room peer-session (peer-ready may fire twice).
    if (!localNonceRef.current) {
      localNonceRef.current = randomHandshakeNonce()
    }
    const hello: NearbyHello = {
      type: 'hello',
      userId: optsRef.current.userId,
      displayName: optsRef.current.displayName,
      publicKey: optsRef.current.publicKey,
      nonce: localNonceRef.current,
    }
    sendRaw(hello)
    trySendKeyConfirm()
    tryUnlockSession()
  }, [sendRaw, trySendKeyConfirm, tryUnlockSession])

  const handlePlain = useCallback(
    async (plain: NearbyPlainSignal) => {
      if (plain.type === 'key-confirm') {
        const local = localNonceRef.current
        const remote = remoteNonceRef.current
        if (!local || !remote) return
        if (plain.digest !== handshakeConfirmDigest(local, remote)) {
          setError('Key confirmation failed — leave and try again')
          return
        }
        confirmOkRef.current = true
        tryUnlockSession()
        return
      }
      if (
        phaseRef.current === 'connecting' ||
        phaseRef.current === 'verify' ||
        phaseRef.current === 'scanning' ||
        phaseRef.current === 'idle'
      ) {
        return
      }
      if (plain.type === 'chat') {
        setMessages((prev) => {
          if (prev.some((m) => m.id === plain.id)) return prev
          return [
            ...prev,
            {
              id: plain.id,
              text: plain.text,
              fromName: plain.fromName,
              sentAt: plain.sentAt,
              mine: false,
            },
          ]
        })
        return
      }
      if (plain.type === 'call-offer') {
        setRemoteName(plain.fromName)
        setRemoteFingerprint(plain.fingerprint)
        setPhase('incoming')
        setStatus(`Incoming call from ${plain.fromName}`)
        return
      }
      if (plain.type === 'call-reject') {
        cleanupMedia()
        setPhase('ready')
        setStatus('Call declined')
        return
      }
      if (plain.type === 'call-end') {
        cleanupMedia()
        setPhase('ready')
        setStatus('Call ended')
        return
      }
      if (plain.type === 'call-answer') {
        setPhase('in_call')
        setStatus('In call')
        return
      }
      if (plain.type === 'webrtc-signal') {
        const pc = await ensurePc()
        const signal = plain.signal
        if ('sdp' in signal && signal.sdp) {
          const desc = signal as RTCSessionDescriptionInit
          const offerCollision =
            desc.type === 'offer' &&
            (makingOfferRef.current || pc.signalingState !== 'stable')
          ignoreOfferRef.current = !politeRef.current && offerCollision
          if (ignoreOfferRef.current) return
          await pc.setRemoteDescription(desc)
          if (desc.type === 'offer') {
            const answer = await pc.createAnswer()
            await pc.setLocalDescription(answer)
            sendSignal({ type: 'webrtc-signal', signal: answer })
          }
        } else {
          try {
            await pc.addIceCandidate(signal as RTCIceCandidateInit)
          } catch {
            if (!ignoreOfferRef.current) {
              /* ignore late ICE */
            }
          }
        }
      }
    },
    [cleanupMedia, ensurePc, sendSignal, tryUnlockSession],
  )

  const handleRelay = useCallback(
    async (wire: NearbyWire) => {
      if (wire.type === 'hello') {
        const hello = wire as NearbyHello
        const firstKey = !sessionKeyRef.current
        sessionKeyRef.current = deriveSessionKey(
          optsRef.current.privateKey,
          hello.publicKey,
        )
        pendingPeerRef.current = {
          userId: hello.userId,
          displayName: hello.displayName,
          publicKey: hello.publicKey,
        }
        remoteNonceRef.current = hello.nonce ?? null
        setRemoteName(hello.displayName)
        setRemoteFingerprint(keyFingerprint(hello.publicKey))
        politeRef.current = optsRef.current.publicKey > hello.publicKey
        if (firstKey) setMessages([])
        // Reply with our hello if we haven't yet; otherwise just finish confirm.
        if (!localNonceRef.current) sendHello()
        else {
          trySendKeyConfirm()
          tryUnlockSession()
        }
        setStatus(`Connected to ${hello.displayName} — confirming keys…`)
        return
      }
      if (wire.type === 'enc') {
        const key = sessionKeyRef.current
        if (!key) return
        const plain = decryptJson<NearbyPlainSignal>(key, wire.payload)
        if (plain) await handlePlain(plain)
      }
    },
    [handlePlain, sendHello, trySendKeyConfirm, tryUnlockSession],
  )

  const closeWs = useCallback(() => {
    wsRef.current?.close()
    wsRef.current = null
  }, [])

  const connectWs = useCallback(
    (code: string) => {
      const token = getToken()
      if (!token) throw new Error('Not signed in')
      closeWs()
      sessionKeyRef.current = null
      resetHandshake()
      const ws = new WebSocket(lanWsUrl(code, token))
      wsRef.current = ws
      ws.onmessage = (ev) => {
        let msg: {
          type: string
          payload?: NearbyWire
          displayName?: string
        }
        try {
          msg = JSON.parse(String(ev.data))
        } catch {
          return
        }
        if (msg.type === 'room') {
          setStatus(`In room ${code}`)
          return
        }
        if (msg.type === 'peer-joined' || msg.type === 'peer-ready') {
          setStatus('Peer connected — exchanging keys…')
          setPhase('connecting')
          sendHello()
          return
        }
        if (msg.type === 'peer-left') {
          cleanupMedia()
          sessionKeyRef.current = null
          resetHandshake()
          setMessages([])
          setRemoteName(null)
          setRemoteFingerprint(null)
          setPhase('scanning')
          setStatus('Peer left — waiting…')
          return
        }
        if (msg.type === 'relay' && msg.payload) {
          void handleRelay(msg.payload)
        }
      }
      ws.onerror = () =>
        setError(
          'Could not reach Presence for this room. Online rooms need internet (the server may be waking). For offline Bluetooth chat/calls, install the Android app.',
        )
      ws.onclose = (ev) => {
        if (wsRef.current === ws) wsRef.current = null
        if (ev.code === 4401) {
          setError('Session expired — sign in again, then retry the room.')
          setPhase('idle')
        }
      }
    },
    [cleanupMedia, closeWs, handleRelay, resetHandshake, sendHello],
  )

  const createRoom = useCallback(async () => {
    setError(null)
    setPhase('scanning')
    setStatus('Creating room…')
    const token = getToken()
    if (!token) {
      setError('Not signed in')
      setPhase('idle')
      return
    }
    try {
      const res = await fetch(apiUrl('/nearby/lan/rooms'), {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) throw new Error('Could not create room')
      const body = (await res.json()) as { code: string }
      setRoomCode(body.code)
      setStatus(`Share code ${body.code} — waiting for peer…`)
      connectWs(body.code)
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : 'Could not create room — check that you are online.',
      )
      setPhase('idle')
    }
  }, [connectWs])

  const joinRoom = useCallback(
    async (code: string) => {
      setError(null)
      const normalized = code.trim().toUpperCase()
      if (normalized.length < 4) {
        setError('Enter the room code')
        return
      }
      setPhase('connecting')
      setStatus(`Joining ${normalized}…`)
      const token = getToken()
      if (!token) {
        setError('Not signed in')
        setPhase('idle')
        return
      }
      try {
        const res = await fetch(
          apiUrl(`/nearby/lan/rooms/${encodeURIComponent(normalized)}/join`),
          {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}` },
          },
        )
        if (!res.ok) {
          const body = await res.json().catch(() => ({}))
          throw new Error(body.detail ?? 'Join failed')
        }
        setRoomCode(normalized)
        connectWs(normalized)
      } catch (e) {
        setError(
          e instanceof Error
            ? e.message
            : 'Could not join room — check the code and that you are online.',
        )
        setPhase('idle')
      }
    },
    [connectWs],
  )

  const leaveRoom = useCallback(() => {
    cleanupMedia()
    closeWs()
    sessionKeyRef.current = null
    resetHandshake()
    setMessages([])
    setRoomCode(null)
    setRemoteName(null)
    setRemoteFingerprint(null)
    setPhase('idle')
    setStatus('')
    setMuted(false)
  }, [cleanupMedia, closeWs, resetHandshake])

  const confirmPeer = useCallback(() => {
    const pending = pendingPeerRef.current
    if (!pending || phaseRef.current !== 'verify') return
    confirmPeerKey(pending.userId, pending.publicKey)
    setPinStatus('known')
    setPhase('ready')
    setStatus(`Connected to ${pending.displayName} · verified`)
  }, [])

  const rejectPeer = useCallback(() => {
    leaveRoom()
  }, [leaveRoom])

  useEffect(() => () => leaveRoom(), [leaveRoom])

  const startCall = useCallback(async () => {
    if (!sessionKeyRef.current) {
      setError('Wait for key exchange')
      return
    }
    setError(null)
    setPhase('outgoing')
    setStatus('Calling…')
    try {
      sendSignal({
        type: 'call-offer',
        fromName: optsRef.current.displayName,
        fingerprint: keyFingerprint(optsRef.current.publicKey),
      })
      const pc = await ensurePc()
      makingOfferRef.current = true
      const offer = await pc.createOffer()
      await pc.setLocalDescription(offer)
      sendSignal({ type: 'webrtc-signal', signal: offer })
      makingOfferRef.current = false
    } catch (e) {
      makingOfferRef.current = false
      cleanupMedia()
      setError(e instanceof Error ? e.message : 'Call failed')
      setPhase('ready')
    }
  }, [cleanupMedia, ensurePc, sendSignal])

  const acceptCall = useCallback(async () => {
    try {
      await ensurePc()
      sendSignal({ type: 'call-answer' })
      setPhase('in_call')
      setStatus('In call')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Accept failed')
      setPhase('ready')
    }
  }, [ensurePc, sendSignal])

  const rejectCall = useCallback(() => {
    try {
      sendSignal({ type: 'call-reject' })
    } catch {
      /* ignore */
    }
    cleanupMedia()
    setPhase('ready')
    setStatus('Declined')
  }, [cleanupMedia, sendSignal])

  const endCall = useCallback(() => {
    try {
      sendSignal({ type: 'call-end' })
    } catch {
      /* ignore */
    }
    cleanupMedia()
    setMuted(false)
    setPhase(sessionKeyRef.current ? 'ready' : 'scanning')
    setStatus('Call ended')
  }, [cleanupMedia, sendSignal])

  const toggleMute = useCallback(() => {
    const stream = localStreamRef.current
    if (!stream) return
    const next = !muted
    for (const track of stream.getAudioTracks()) track.enabled = !next
    setMuted(next)
  }, [muted])

  const setRemoteAudioEl = useCallback((el: HTMLAudioElement | null) => {
    remoteAudioRef.current = el
  }, [])

  const sendChat = useCallback(
    (text: string) => {
      const trimmed = text.trim()
      if (!trimmed || !sessionKeyRef.current) return
      const msg: NearbyChatMessage = {
        id: crypto.randomUUID(),
        text: trimmed.slice(0, 2000),
        fromName: optsRef.current.displayName,
        sentAt: Date.now(),
        mine: true,
      }
      sendSignal({
        type: 'chat',
        id: msg.id,
        text: msg.text,
        fromName: msg.fromName,
        sentAt: msg.sentAt,
      })
      setMessages((prev) => [...prev, msg])
    },
    [sendSignal],
  )

  return {
    phase,
    roomCode,
    remoteName,
    remoteFingerprint,
    pinStatus,
    confirmPeer,
    rejectPeer,
    muted,
    error,
    status,
    messages,
    createRoom,
    joinRoom,
    leaveRoom,
    startCall,
    acceptCall,
    rejectCall,
    endCall,
    toggleMute,
    setRemoteAudioEl,
    sendChat,
  }
}