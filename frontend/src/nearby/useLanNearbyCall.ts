import { useCallback, useEffect, useRef, useState } from 'react'
import {
  deriveSessionKey,
  encryptJson,
  decryptJson,
  keyFingerprint,
} from '../crypto'
import { getToken } from '../api'
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
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${window.location.host}/nearby/lan/ws?token=${encodeURIComponent(token)}&code=${encodeURIComponent(code)}`
}

export function useLanNearbyCall(opts: UseLanNearbyCallOptions) {
  const [phase, setPhase] = useState<NearbyCallPhase>('idle')
  const [roomCode, setRoomCode] = useState<string | null>(null)
  const [remoteName, setRemoteName] = useState<string | null>(null)
  const [remoteFingerprint, setRemoteFingerprint] = useState<string | null>(null)
  const [muted, setMuted] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState('')
  const [messages, setMessages] = useState<NearbyChatMessage[]>([])

  const sessionKeyRef = useRef<Uint8Array | null>(null)
  const pcRef = useRef<RTCPeerConnection | null>(null)
  const localStreamRef = useRef<MediaStream | null>(null)
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const makingOfferRef = useRef(false)
  const politeRef = useRef(false)
  const ignoreOfferRef = useRef(false)
  const optsRef = useRef(opts)
  optsRef.current = opts
  // hello exchanged each peer-ready

  const cleanupMedia = useCallback(() => {
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
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: false,
    })
    localStreamRef.current = stream
    for (const track of stream.getTracks()) {
      pc.addTrack(track, stream)
    }
    return pc
  }, [sendSignal])

  const sendHello = useCallback(() => {
    const hello: NearbyHello = {
      type: 'hello',
      userId: optsRef.current.userId,
      displayName: optsRef.current.displayName,
      publicKey: optsRef.current.publicKey,
    }
    sendRaw(hello)
  }, [sendRaw])

  const handlePlain = useCallback(
    async (plain: NearbyPlainSignal) => {
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
    [cleanupMedia, ensurePc, sendSignal],
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
        setRemoteName(hello.displayName)
        setRemoteFingerprint(keyFingerprint(hello.publicKey))
        politeRef.current = optsRef.current.publicKey > hello.publicKey
        if (firstKey) {
          setMessages([])
          sendHello()
        }
        setPhase('ready')
        setStatus(`Connected to ${hello.displayName}`)
        return
      }
      if (wire.type === 'enc') {
        const key = sessionKeyRef.current
        if (!key) return
        const plain = decryptJson<NearbyPlainSignal>(key, wire.payload)
        if (plain) await handlePlain(plain)
      }
    },
    [handlePlain, sendHello],
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
          setMessages([])
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
    [cleanupMedia, closeWs, handleRelay, sendHello],
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
      const res = await fetch('/nearby/lan/rooms', {
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
          `/nearby/lan/rooms/${encodeURIComponent(normalized)}/join`,
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
    setMessages([])
    setRoomCode(null)
    setRemoteName(null)
    setRemoteFingerprint(null)
    setPhase('idle')
    setStatus('')
    setMuted(false)
  }, [cleanupMedia, closeWs])

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