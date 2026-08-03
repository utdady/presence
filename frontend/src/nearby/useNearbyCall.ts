import { useCallback, useEffect, useRef, useState } from 'react'
import { PresenceNearby, type NearbyPeer } from 'presence-nearby'
import {
  deriveSessionKey,
  encryptJson,
  decryptJson,
  keyFingerprint,
} from '../crypto'
import { nearbyCallsAvailable } from './capability'
import type {
  NearbyCallPhase,
  NearbyChatMessage,
  NearbyHello,
  NearbyPeerInfo,
  NearbyPlainSignal,
  NearbyWire,
} from './types'

export interface UseNearbyCallOptions {
  userId: string
  displayName: string
  publicKey: string
  privateKey: string
}

const VOICE_TIMESLICE_MS = 200
const MAX_VOICE_B64 = 24_000

function pickRecorderMime(): string {
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4',
    'audio/ogg;codecs=opus',
  ]
  for (const mime of candidates) {
    if (
      typeof MediaRecorder !== 'undefined' &&
      MediaRecorder.isTypeSupported(mime)
    ) {
      return mime
    }
  }
  return ''
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = String(reader.result ?? '')
      const comma = result.indexOf(',')
      resolve(comma >= 0 ? result.slice(comma + 1) : result)
    }
    reader.onerror = () => reject(reader.error ?? new Error('read failed'))
    reader.readAsDataURL(blob)
  })
}

function base64ToBlob(dataB64: string, mime: string): Blob {
  const bin = atob(dataB64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new Blob([bytes], { type: mime || 'audio/webm' })
}

export function useNearbyCall(opts: UseNearbyCallOptions) {
  const [available, setAvailable] = useState<boolean | null>(null)
  const [phase, setPhase] = useState<NearbyCallPhase>('idle')
  const [peers, setPeers] = useState<NearbyPeerInfo[]>([])
  const [connectedPeer, setConnectedPeer] = useState<NearbyPeerInfo | null>(null)
  const [remoteName, setRemoteName] = useState<string | null>(null)
  const [remoteFingerprint, setRemoteFingerprint] = useState<string | null>(null)
  const [muted, setMuted] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<string>('')
  const [messages, setMessages] = useState<NearbyChatMessage[]>([])

  const sessionKeyRef = useRef<Uint8Array | null>(null)
  const localStreamRef = useRef<MediaStream | null>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null)
  const voiceIdRef = useRef(crypto.randomUUID())
  const voiceSeqRef = useRef(0)
  const playQueueRef = useRef<Blob[]>([])
  const playingRef = useRef(false)
  const mutedRef = useRef(false)
  const optsRef = useRef(opts)
  optsRef.current = opts

  const pumpPlayback = useCallback(() => {
    if (playingRef.current) return
    const audio = remoteAudioRef.current
    const next = playQueueRef.current.shift()
    if (!audio || !next) return
    playingRef.current = true
    const url = URL.createObjectURL(next)
    audio.srcObject = null
    audio.src = url
    const clear = () => {
      URL.revokeObjectURL(url)
      playingRef.current = false
      pumpPlayback()
    }
    audio.onended = clear
    audio.onerror = clear
    void audio.play().catch(clear)
  }, [])

  const stopVoiceCapture = useCallback(() => {
    const recorder = recorderRef.current
    if (recorder && recorder.state !== 'inactive') {
      try {
        recorder.stop()
      } catch {
        /* ignore */
      }
    }
    recorderRef.current = null
    localStreamRef.current?.getTracks().forEach((t) => t.stop())
    localStreamRef.current = null
  }, [])

  const cleanupMedia = useCallback(() => {
    stopVoiceCapture()
    playQueueRef.current = []
    playingRef.current = false
    if (remoteAudioRef.current) {
      remoteAudioRef.current.pause()
      remoteAudioRef.current.removeAttribute('src')
      remoteAudioRef.current.srcObject = null
    }
    setMuted(false)
    mutedRef.current = false
  }, [stopVoiceCapture])

  const sendRaw = useCallback(async (wire: NearbyWire) => {
    await PresenceNearby.send({ data: JSON.stringify(wire) })
  }, [])

  const sendSignal = useCallback(
    async (signal: NearbyPlainSignal) => {
      const key = sessionKeyRef.current
      if (!key) throw new Error('No session key')
      const payload = encryptJson(key, signal)
      await sendRaw({ type: 'enc', payload })
    },
    [sendRaw],
  )

  const startVoiceCapture = useCallback(async () => {
    if (recorderRef.current) return
    const mime = pickRecorderMime()
    if (!mime) {
      throw new Error('This device cannot record call audio')
    }
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: false,
    })
    localStreamRef.current = stream
    voiceIdRef.current = crypto.randomUUID()
    voiceSeqRef.current = 0
    const recorder = new MediaRecorder(stream, { mimeType: mime })
    recorderRef.current = recorder
    recorder.ondataavailable = (ev) => {
      if (!ev.data || ev.data.size === 0 || mutedRef.current) return
      void (async () => {
        try {
          const dataB64 = await blobToBase64(ev.data)
          if (dataB64.length > MAX_VOICE_B64) return
          const seq = voiceSeqRef.current++
          await sendSignal({
            type: 'voice-chunk',
            id: voiceIdRef.current,
            seq,
            mime: ev.data.type || mime,
            dataB64,
          })
        } catch {
          /* drop chunk */
        }
      })()
    }
    recorder.start(VOICE_TIMESLICE_MS)
  }, [sendSignal])

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
      if (plain.type === 'voice-chunk') {
        const blob = base64ToBlob(plain.dataB64, plain.mime)
        playQueueRef.current.push(blob)
        // Cap backlog on slow BT
        if (playQueueRef.current.length > 40) {
          playQueueRef.current.splice(0, playQueueRef.current.length - 40)
        }
        pumpPlayback()
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
        try {
          await startVoiceCapture()
          setPhase('in_call')
          setStatus('In call (Bluetooth)')
        } catch (e) {
          setError(e instanceof Error ? e.message : 'Mic failed')
          setPhase('ready')
        }
        return
      }
      // webrtc-signal ignored on Bluetooth path
    },
    [cleanupMedia, pumpPlayback, startVoiceCapture],
  )

  const handleMessage = useCallback(
    async (data: string) => {
      let wire: NearbyWire
      try {
        wire = JSON.parse(data) as NearbyWire
      } catch {
        return
      }
      if (wire.type === 'hello') {
        const hello = wire as NearbyHello
        const key = deriveSessionKey(optsRef.current.privateKey, hello.publicKey)
        sessionKeyRef.current = key
        setRemoteName(hello.displayName)
        setRemoteFingerprint(keyFingerprint(hello.publicKey))
        setMessages([])
        setPhase('ready')
        setStatus(`Connected to ${hello.displayName}`)
        return
      }
      if (wire.type === 'enc') {
        const key = sessionKeyRef.current
        if (!key) return
        const plain = decryptJson<NearbyPlainSignal>(key, wire.payload)
        if (!plain) return
        await handlePlain(plain)
      }
    },
    [handlePlain],
  )

  useEffect(() => {
    let cancelled = false
    void nearbyCallsAvailable().then((ok) => {
      if (!cancelled) setAvailable(ok)
    })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!available) return
    const handles: Array<{ remove: () => Promise<void> }> = []
    ;(async () => {
      handles.push(
        await PresenceNearby.addListener('peerFound', (peer: NearbyPeer) => {
          setPeers((prev) =>
            prev.some((p) => p.id === peer.id)
              ? prev
              : [...prev, { id: peer.id, name: peer.name }],
          )
        }),
      )
      handles.push(
        await PresenceNearby.addListener('peerLost', (peer) => {
          setPeers((prev) => prev.filter((p) => p.id !== peer.id))
        }),
      )
      handles.push(
        await PresenceNearby.addListener('connected', (peer) => {
          setConnectedPeer({ id: peer.id, name: peer.name })
          setPhase('connecting')
          setStatus('Exchanging keys…')
          const hello: NearbyHello = {
            type: 'hello',
            userId: optsRef.current.userId,
            displayName: optsRef.current.displayName,
            publicKey: optsRef.current.publicKey,
          }
          void sendRaw(hello).catch((e) =>
            setError(e instanceof Error ? e.message : 'hello failed'),
          )
        }),
      )
      handles.push(
        await PresenceNearby.addListener('disconnected', () => {
          cleanupMedia()
          sessionKeyRef.current = null
          setConnectedPeer(null)
          setRemoteName(null)
          setRemoteFingerprint(null)
          setMessages([])
          setPhase('scanning')
          setStatus('Disconnected — still scanning')
        }),
      )
      handles.push(
        await PresenceNearby.addListener('message', (ev) => {
          void handleMessage(ev.data)
        }),
      )
      handles.push(
        await PresenceNearby.addListener('error', (ev) => {
          setError(ev.message)
        }),
      )
    })()
    return () => {
      for (const h of handles) void h.remove()
    }
  }, [available, cleanupMedia, handleMessage, sendRaw])

  const startScanning = useCallback(async () => {
    setError(null)
    setPeers([])
    setPhase('scanning')
    setStatus('Looking for nearby Presence devices…')
    try {
      await PresenceNearby.startAdvertising({
        displayName: optsRef.current.displayName,
      })
      await PresenceNearby.startDiscovery()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not start Nearby')
      setPhase('idle')
    }
  }, [])

  const stopScanning = useCallback(async () => {
    cleanupMedia()
    sessionKeyRef.current = null
    try {
      await PresenceNearby.stop()
    } catch {
      /* ignore */
    }
    setPeers([])
    setConnectedPeer(null)
    setMessages([])
    setPhase('idle')
    setStatus('')
  }, [cleanupMedia])

  const connectTo = useCallback(async (peer: NearbyPeerInfo) => {
    setError(null)
    setPhase('connecting')
    setStatus(`Connecting to ${peer.name}…`)
    try {
      await PresenceNearby.connect({
        endpointId: peer.id,
        displayName: optsRef.current.displayName,
      })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Connect failed')
      setPhase('scanning')
    }
  }, [])

  const startCall = useCallback(async () => {
    if (!sessionKeyRef.current) {
      setError('Not ready — wait for key exchange')
      return
    }
    setError(null)
    setPhase('outgoing')
    setStatus('Calling…')
    try {
      await sendSignal({
        type: 'call-offer',
        fromName: optsRef.current.displayName,
        fingerprint: keyFingerprint(optsRef.current.publicKey),
      })
    } catch (e) {
      cleanupMedia()
      setError(e instanceof Error ? e.message : 'Call failed')
      setPhase('ready')
    }
  }, [cleanupMedia, sendSignal])

  const acceptCall = useCallback(async () => {
    setError(null)
    try {
      await sendSignal({ type: 'call-answer' })
      await startVoiceCapture()
      setPhase('in_call')
      setStatus('In call (Bluetooth)')
    } catch (e) {
      cleanupMedia()
      setError(e instanceof Error ? e.message : 'Accept failed')
      setPhase('ready')
    }
  }, [cleanupMedia, sendSignal, startVoiceCapture])

  const rejectCall = useCallback(async () => {
    try {
      await sendSignal({ type: 'call-reject' })
    } catch {
      /* ignore */
    }
    cleanupMedia()
    setPhase('ready')
    setStatus('Declined')
  }, [cleanupMedia, sendSignal])

  const endCall = useCallback(async () => {
    try {
      await sendSignal({ type: 'call-end' })
    } catch {
      /* ignore */
    }
    cleanupMedia()
    setPhase(sessionKeyRef.current ? 'ready' : 'scanning')
    setStatus('Call ended')
  }, [cleanupMedia, sendSignal])

  const toggleMute = useCallback(() => {
    const next = !mutedRef.current
    mutedRef.current = next
    setMuted(next)
    const stream = localStreamRef.current
    if (stream) {
      for (const track of stream.getAudioTracks()) {
        track.enabled = !next
      }
    }
  }, [])

  const setRemoteAudioEl = useCallback((el: HTMLAudioElement | null) => {
    remoteAudioRef.current = el
  }, [])

  const sendChat = useCallback(
    async (text: string) => {
      const trimmed = text.trim()
      if (!trimmed || !sessionKeyRef.current) return
      const msg: NearbyChatMessage = {
        id: crypto.randomUUID(),
        text: trimmed.slice(0, 2000),
        fromName: optsRef.current.displayName,
        sentAt: Date.now(),
        mine: true,
      }
      await sendSignal({
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
    available,
    phase,
    peers,
    connectedPeer,
    remoteName,
    remoteFingerprint,
    muted,
    error,
    status,
    messages,
    startScanning,
    stopScanning,
    connectTo,
    startCall,
    acceptCall,
    rejectCall,
    endCall,
    toggleMute,
    setRemoteAudioEl,
    sendChat,
  }
}
