import { useCallback, useEffect, useRef, useState } from 'react'
import { PresenceNearby, type NearbyPeer } from 'presence-nearby'
import {
  deriveSessionKey,
  encryptJson,
  decryptJson,
  keyFingerprint,
} from '../crypto'
import {
  blobToBase64,
  measureBlobDurationMs,
  pickRecorderMime,
  VOICE_MAX_B64_CHARS,
  VOICE_MAX_MS,
} from '../voiceAudio'
import { nearbyCallsAvailable } from './capability'
import {
  friendlyNearbyError,
  type NearbyCallPhase,
  type NearbyChatMessage,
  type NearbyHello,
  type NearbyPeerInfo,
  type NearbyPlainSignal,
  type NearbyWire,
} from './types'

export interface UseNearbyCallOptions {
  userId: string
  displayName: string
  publicKey: string
  privateKey: string
}

const VOICE_TIMESLICE_MS = 100
const MAX_VOICE_B64 = 12_000
const MAX_QUEUE_CHUNKS = 12
const NEARBY_VOICE_NOTE_MAX_B64 = 400_000

function base64ToUint8(dataB64: string): Uint8Array {
  const bin = atob(dataB64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
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
  const [catchingUp, setCatchingUp] = useState(false)
  const [recordingNote, setRecordingNote] = useState(false)

  const sessionKeyRef = useRef<Uint8Array | null>(null)
  const localStreamRef = useRef<MediaStream | null>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null)
  const voiceIdRef = useRef(crypto.randomUUID())
  const voiceSeqRef = useRef(0)
  const playQueueRef = useRef<Uint8Array[]>([])
  const blobQueueRef = useRef<Blob[]>([])
  const playingRef = useRef(false)
  const mutedRef = useRef(false)
  const phaseRef = useRef<NearbyCallPhase>('idle')
  const mediaGenRef = useRef(0)
  const mseRef = useRef<MediaSource | null>(null)
  const sourceBufferRef = useRef<SourceBuffer | null>(null)
  const mseMimeRef = useRef('')
  const noteRecorderRef = useRef<MediaRecorder | null>(null)
  const noteChunksRef = useRef<Blob[]>([])
  const noteStreamRef = useRef<MediaStream | null>(null)
  const noteStartedRef = useRef(0)
  const noteGenRef = useRef(0)
  const fileAbortRef = useRef<{ id: string; cancel: boolean } | null>(null)
  const [fileTransfer, setFileTransfer] = useState<{
    name: string
    sent: number
    total: number
  } | null>(null)
  const lastErrorAtRef = useRef(0)
  const optsRef = useRef(opts)
  optsRef.current = opts
  phaseRef.current = phase
  const fileBufRef = useRef(
    new Map<
      string,
      {
        chunks: (string | undefined)[]
        meta: Extract<NearbyPlainSignal, { type: 'file-meta' }>
      }
    >(),
  )

  const stopVoiceCapture = useCallback(() => {
    mediaGenRef.current += 1
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

  const resetMse = useCallback(() => {
    sourceBufferRef.current = null
    if (mseRef.current) {
      try {
        if (mseRef.current.readyState === 'open') mseRef.current.endOfStream()
      } catch {
        /* ignore */
      }
    }
    mseRef.current = null
    mseMimeRef.current = ''
    playQueueRef.current = []
    blobQueueRef.current = []
    playingRef.current = false
    setCatchingUp(false)
    if (remoteAudioRef.current) {
      remoteAudioRef.current.pause()
      remoteAudioRef.current.removeAttribute('src')
      remoteAudioRef.current.srcObject = null
    }
  }, [])

  const cleanupMedia = useCallback(() => {
    stopVoiceCapture()
    resetMse()
    setMuted(false)
    mutedRef.current = false
  }, [resetMse, stopVoiceCapture])

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

  const flushMse = useCallback(() => {
    const sb = sourceBufferRef.current
    const mse = mseRef.current
    if (!sb || !mse || sb.updating) return
    const next = playQueueRef.current.shift()
    if (!next) {
      setCatchingUp(false)
      return
    }
    try {
      // Copy for ArrayBufferView typing
      const copy = new Uint8Array(next.byteLength)
      copy.set(next)
      sb.appendBuffer(copy.buffer)
    } catch {
      playQueueRef.current.unshift(next)
    }
  }, [])

  const enqueueVoiceChunk = useCallback(
    (dataB64: string, mime: string) => {
      const bytes = base64ToUint8(dataB64)
      const audio = remoteAudioRef.current
      if (!audio) return

      const preferMse =
        typeof MediaSource !== 'undefined' &&
        MediaSource.isTypeSupported(mime || 'audio/webm;codecs=opus')

      if (preferMse) {
        if (!mseRef.current || mseMimeRef.current !== mime) {
          resetMse()
          const mse = new MediaSource()
          mseRef.current = mse
          mseMimeRef.current = mime
          audio.srcObject = null
          audio.src = URL.createObjectURL(mse)
          mse.addEventListener('sourceopen', () => {
            try {
              const sb = mse.addSourceBuffer(mime || 'audio/webm;codecs=opus')
              sourceBufferRef.current = sb
              sb.mode = 'sequence'
              sb.addEventListener('updateend', () => flushMse())
              flushMse()
              void audio.play().catch(() => {})
            } catch {
              /* fall through to queue blob mode below */
            }
          })
        }
        playQueueRef.current.push(bytes)
        if (playQueueRef.current.length > MAX_QUEUE_CHUNKS) {
          const drop = playQueueRef.current.length - MAX_QUEUE_CHUNKS
          playQueueRef.current.splice(0, drop)
          setCatchingUp(true)
        }
        flushMse()
        return
      }

      // Fallback: short blob queue; skip toward live if backlog grows
      const copy = new Uint8Array(bytes.byteLength)
      copy.set(bytes)
      blobQueueRef.current.push(
        new Blob([copy.buffer], { type: mime || 'audio/webm' }),
      )
      if (blobQueueRef.current.length > MAX_QUEUE_CHUNKS) {
        blobQueueRef.current.splice(0, blobQueueRef.current.length - 3)
        setCatchingUp(true)
      }
      const pump = () => {
        if (playingRef.current) return
        const next = blobQueueRef.current.shift()
        if (!next || !remoteAudioRef.current) return
        playingRef.current = true
        const url = URL.createObjectURL(next)
        const el = remoteAudioRef.current
        el.srcObject = null
        el.src = url
        const clear = () => {
          URL.revokeObjectURL(url)
          playingRef.current = false
          if (blobQueueRef.current.length <= 2) setCatchingUp(false)
          pump()
        }
        el.onended = clear
        el.onerror = clear
        void el.play().catch(clear)
      }
      pump()
    },
    [flushMse, resetMse],
  )

  const startVoiceCapture = useCallback(async () => {
    if (recorderRef.current) return
    const mime = pickRecorderMime()
    if (!mime) throw new Error('This device cannot record call audio')
    const gen = ++mediaGenRef.current
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        channelCount: 1,
      },
      video: false,
    })
    if (gen !== mediaGenRef.current) {
      stream.getTracks().forEach((t) => t.stop())
      return
    }
    localStreamRef.current = stream
    voiceIdRef.current = crypto.randomUUID()
    voiceSeqRef.current = 0
    const recorder = new MediaRecorder(stream, {
      mimeType: mime,
      audioBitsPerSecond: 16_000,
    })
    recorderRef.current = recorder
    recorder.ondataavailable = (ev) => {
      if (!ev.data || ev.data.size === 0 || mutedRef.current) return
      if (phaseRef.current !== 'in_call') return
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
          /* drop */
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
              kind: 'text',
            },
          ]
        })
        return
      }
      if (plain.type === 'voice-note') {
        setMessages((prev) => {
          if (prev.some((m) => m.id === plain.id)) return prev
          return [
            ...prev,
            {
              id: plain.id,
              text: '',
              fromName: plain.fromName,
              sentAt: plain.sentAt,
              mine: false,
              kind: 'voice',
              audio_b64: plain.dataB64,
              audio_mime: plain.mime,
              duration_ms: plain.durationMs,
            },
          ]
        })
        return
      }
      if (plain.type === 'file-meta') {
        setMessages((prev) => {
          if (prev.some((m) => m.id === plain.id)) return prev
          return [
            ...prev,
            {
              id: plain.id,
              text: `Receiving ${plain.name}…`,
              fromName: plain.fromName,
              sentAt: plain.sentAt,
              mine: false,
              kind: 'file',
              file_name: plain.name,
              file_mime: plain.mime,
              file_size: plain.size,
            },
          ]
        })
        fileBufRef.current.set(plain.id, {
          chunks: new Array(plain.totalChunks),
          meta: plain,
        })
        return
      }
      if (plain.type === 'file-chunk') {
        const buf = fileBufRef.current.get(plain.id)
        if (!buf) return
        buf.chunks[plain.index] = plain.dataB64
        return
      }
      if (plain.type === 'file-end') {
        const buf = fileBufRef.current.get(plain.id)
        if (!buf) return
        fileBufRef.current.delete(plain.id)
        if (buf.chunks.some((c) => !c)) {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === plain.id
                ? { ...m, text: `Failed to receive ${buf.meta.name}` }
                : m,
            ),
          )
          return
        }
        const dataB64 = buf.chunks.join('')
        setMessages((prev) =>
          prev.map((m) =>
            m.id === plain.id
              ? {
                  ...m,
                  text: buf.meta.name,
                  file_b64: dataB64,
                  file_name: buf.meta.name,
                  file_mime: buf.meta.mime,
                  file_size: buf.meta.size,
                }
              : m,
          ),
        )
        return
      }
      if (plain.type === 'file-cancel') {
        fileBufRef.current.delete(plain.id)
        setMessages((prev) =>
          prev.map((m) =>
            m.id === plain.id ? { ...m, text: 'Transfer cancelled' } : m,
          ),
        )
        return
      }
      if (plain.type === 'voice-chunk') {
        enqueueVoiceChunk(plain.dataB64, plain.mime)
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
        if (phaseRef.current !== 'outgoing') return
        try {
          setPhase('in_call')
          await startVoiceCapture()
          setStatus(catchingUp ? 'In call — catching up…' : 'In call')
        } catch (e) {
          setError(e instanceof Error ? e.message : 'Mic failed')
          setPhase('ready')
        }
      }
    },
    [cleanupMedia, enqueueVoiceChunk, startVoiceCapture],
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

  const reportError = useCallback((raw: string) => {
    const now = Date.now()
    if (now - lastErrorAtRef.current < 2500) return
    lastErrorAtRef.current = now
    setError(friendlyNearbyError(raw))
  }, [])

  useEffect(() => {
    if (!available) return
    const handles: Array<{ remove: () => Promise<void> }> = []
    let alive = true
    ;(async () => {
      handles.push(
        await PresenceNearby.addListener('peerFound', (peer: NearbyPeer) => {
          if (!alive) return
          setPeers((prev) =>
            prev.some((p) => p.id === peer.id)
              ? prev
              : [...prev, { id: peer.id, name: peer.name }],
          )
        }),
      )
      handles.push(
        await PresenceNearby.addListener('peerLost', (peer) => {
          if (!alive) return
          setPeers((prev) => prev.filter((p) => p.id !== peer.id))
        }),
      )
      handles.push(
        await PresenceNearby.addListener('connected', (peer) => {
          if (!alive) return
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
            reportError(e instanceof Error ? e.message : 'hello failed'),
          )
        }),
      )
      handles.push(
        await PresenceNearby.addListener('disconnected', () => {
          if (!alive) return
          cleanupMedia()
          sessionKeyRef.current = null
          setConnectedPeer(null)
          setRemoteName(null)
          setRemoteFingerprint(null)
          setMessages([])
          setPhase('scanning')
          setStatus('Disconnected — resuming scan…')
          void (async () => {
            try {
              await PresenceNearby.startAdvertising({
                displayName: optsRef.current.displayName,
              })
              await PresenceNearby.startDiscovery()
              setStatus('Disconnected — still scanning')
            } catch {
              setStatus('Disconnected — tap Find nearby to scan again')
              setPhase('idle')
            }
          })()
        }),
      )
      handles.push(
        await PresenceNearby.addListener('message', (ev) => {
          if (!alive) return
          void handleMessage(ev.data)
        }),
      )
      handles.push(
        await PresenceNearby.addListener('error', (ev) => {
          if (!alive) return
          reportError(ev.message)
        }),
      )
    })()
    return () => {
      alive = false
      for (const h of handles) void h.remove()
    }
  }, [available, cleanupMedia, handleMessage, reportError, sendRaw])

  // Unmount: always release mic + BT
  useEffect(() => {
    return () => {
      cleanupMedia()
      void PresenceNearby.stop().catch(() => {})
    }
  }, [cleanupMedia])

  const startScanning = useCallback(async () => {
    setError(null)
    setPeers([])
    setPhase('scanning')
    setStatus(
      `Looking for peers… You appear as Presence/${optsRef.current.displayName}. Only one side taps Connect.`,
    )
    try {
      try {
        await PresenceNearby.stop()
      } catch {
        /* ignore */
      }
      try {
        await PresenceNearby.requestPermissions()
      } catch (permErr) {
        reportError(
          permErr instanceof Error
            ? permErr.message
            : 'Bluetooth permission is required for Nearby',
        )
        setPhase('idle')
        return
      }
      await PresenceNearby.startAdvertising({
        displayName: optsRef.current.displayName,
      })
      await PresenceNearby.startDiscovery()
    } catch (e) {
      reportError(e instanceof Error ? e.message : 'Could not start Nearby')
      setPhase('idle')
      try {
        await PresenceNearby.stop()
      } catch {
        /* ignore */
      }
    }
  }, [reportError])

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
    setError(null)
  }, [cleanupMedia])

  const connectTo = useCallback(
    async (peer: NearbyPeerInfo) => {
      setError(null)
      setPhase('connecting')
      setStatus(`Connecting to ${peer.name}…`)
      try {
        await PresenceNearby.connect({
          endpointId: peer.id,
          displayName: optsRef.current.displayName,
        })
        setStatus('Connected — exchanging keys…')
      } catch (e) {
        reportError(e instanceof Error ? e.message : 'Connect failed')
        setPhase('scanning')
        setStatus('Still scanning — connect from the side that sees the peer')
        try {
          await PresenceNearby.startAdvertising({
            displayName: optsRef.current.displayName,
          })
          await PresenceNearby.startDiscovery()
        } catch {
          /* ignore */
        }
      }
    },
    [reportError],
  )

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
      reportError(e instanceof Error ? e.message : 'Call failed')
      setPhase('ready')
    }
  }, [cleanupMedia, reportError, sendSignal])

  const acceptCall = useCallback(async () => {
    setError(null)
    try {
      await sendSignal({ type: 'call-answer' })
      setPhase('in_call')
      await startVoiceCapture()
      setStatus('In call')
    } catch (e) {
      cleanupMedia()
      reportError(e instanceof Error ? e.message : 'Accept failed')
      setPhase('ready')
    }
  }, [cleanupMedia, reportError, sendSignal, startVoiceCapture])

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
        kind: 'text',
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

  const startVoiceNote = useCallback(async () => {
    if (!sessionKeyRef.current || recordingNote) return
    const mime = pickRecorderMime()
    if (!mime) {
      setError('Voice notes not supported on this device')
      return
    }
    const gen = ++noteGenRef.current
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      if (gen !== noteGenRef.current) {
        stream.getTracks().forEach((t) => t.stop())
        return
      }
      noteStreamRef.current = stream
      noteChunksRef.current = []
      noteStartedRef.current = Date.now()
      const rec = new MediaRecorder(stream, { mimeType: mime })
      noteRecorderRef.current = rec
      rec.ondataavailable = (ev) => {
        if (ev.data.size) noteChunksRef.current.push(ev.data)
      }
      rec.start()
      setRecordingNote(true)
      window.setTimeout(() => {
        if (noteRecorderRef.current === rec && rec.state !== 'inactive') {
          rec.stop()
        }
      }, VOICE_MAX_MS)
    } catch {
      if (gen === noteGenRef.current) {
        setError('Microphone access denied or unavailable')
      }
    }
  }, [recordingNote])

  const cancelVoiceNote = useCallback(() => {
    noteGenRef.current += 1
    const rec = noteRecorderRef.current
    if (rec && rec.state !== 'inactive') {
      try {
        rec.stop()
      } catch {
        /* ignore */
      }
    }
    noteRecorderRef.current = null
    noteStreamRef.current?.getTracks().forEach((t) => t.stop())
    noteStreamRef.current = null
    noteChunksRef.current = []
    setRecordingNote(false)
  }, [])

  const stopVoiceNote = useCallback(async () => {
    const rec = noteRecorderRef.current
    if (!rec) return
    const mime = rec.mimeType || 'audio/webm'
    const wall = Date.now() - noteStartedRef.current
    await new Promise<void>((resolve) => {
      rec.onstop = () => resolve()
      try {
        rec.stop()
      } catch {
        resolve()
      }
    })
    noteStreamRef.current?.getTracks().forEach((t) => t.stop())
    noteStreamRef.current = null
    noteRecorderRef.current = null
    setRecordingNote(false)
    const blob = new Blob(noteChunksRef.current, { type: mime })
    noteChunksRef.current = []
    if (blob.size < 200) return
    const dataB64 = await blobToBase64(blob)
    if (dataB64.length > NEARBY_VOICE_NOTE_MAX_B64 || dataB64.length > VOICE_MAX_B64_CHARS) {
      setError('Voice note too large — keep it shorter')
      return
    }
    const durationMs = await measureBlobDurationMs(blob, wall)
    const id = crypto.randomUUID()
    const sentAt = Date.now()
    await sendSignal({
      type: 'voice-note',
      id,
      mime,
      dataB64,
      durationMs,
      fromName: optsRef.current.displayName,
      sentAt,
    })
    setMessages((prev) => [
      ...prev,
      {
        id,
        text: '',
        fromName: optsRef.current.displayName,
        sentAt,
        mine: true,
        kind: 'voice',
        audio_b64: dataB64,
        audio_mime: mime,
        duration_ms: durationMs,
      },
    ])
  }, [sendSignal])

  const FILE_CHUNK_CHARS = 24_000
  const FILE_MAX_BYTES = 2_500_000

  const cancelFile = useCallback(() => {
    const cur = fileAbortRef.current
    if (!cur || cur.cancel) return
    cur.cancel = true
    void sendSignal({ type: 'file-cancel', id: cur.id })
    setMessages((prev) =>
      prev.map((m) =>
        m.id === cur.id ? { ...m, text: 'Transfer cancelled' } : m,
      ),
    )
    setFileTransfer(null)
  }, [sendSignal])

  const sendFile = useCallback(
    async (file: File) => {
      if (!sessionKeyRef.current) return
      if (file.size > FILE_MAX_BYTES) {
        setError('File too large (max ~2.5 MB while both online)')
        return
      }
      if (fileAbortRef.current) {
        setError('Another transfer is in progress')
        return
      }
      const buf = new Uint8Array(await file.arrayBuffer())
      let binary = ''
      const chunk = 0x8000
      for (let i = 0; i < buf.length; i += chunk) {
        binary += Array.from(buf.subarray(i, i + chunk), (b) =>
          String.fromCharCode(b),
        ).join('')
      }
      const dataB64 = btoa(binary)
      const id = crypto.randomUUID()
      const totalChunks = Math.ceil(dataB64.length / FILE_CHUNK_CHARS) || 1
      const sentAt = Date.now()
      fileAbortRef.current = { id, cancel: false }
      setFileTransfer({ name: file.name, sent: 0, total: totalChunks })
      setMessages((prev) => [
        ...prev,
        {
          id,
          text: `Sending ${file.name}…`,
          fromName: optsRef.current.displayName,
          sentAt,
          mine: true,
          kind: 'file',
          file_name: file.name,
          file_mime: file.type || 'application/octet-stream',
          file_size: file.size,
        },
      ])
      await sendSignal({
        type: 'file-meta',
        id,
        name: file.name.slice(0, 180),
        mime: file.type || 'application/octet-stream',
        size: file.size,
        totalChunks,
        fromName: optsRef.current.displayName,
        sentAt,
      })
      for (let i = 0; i < totalChunks; i++) {
        const cur = fileAbortRef.current
        if (!cur || cur.id !== id || cur.cancel) {
          fileAbortRef.current = null
          setFileTransfer(null)
          return
        }
        const piece = dataB64.slice(
          i * FILE_CHUNK_CHARS,
          (i + 1) * FILE_CHUNK_CHARS,
        )
        await sendSignal({ type: 'file-chunk', id, index: i, dataB64: piece })
        setFileTransfer({ name: file.name, sent: i + 1, total: totalChunks })
      }
      const cur = fileAbortRef.current
      if (!cur || cur.id !== id || cur.cancel) {
        fileAbortRef.current = null
        setFileTransfer(null)
        return
      }
      await sendSignal({ type: 'file-end', id })
      fileAbortRef.current = null
      setFileTransfer(null)
      setMessages((prev) =>
        prev.map((m) =>
          m.id === id
            ? {
                ...m,
                text: file.name,
                file_b64: dataB64,
              }
            : m,
        ),
      )
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
    catchingUp,
    recordingNote,
    fileTransfer,
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
    startVoiceNote,
    stopVoiceNote,
    cancelVoiceNote,
    sendFile,
    cancelFile,
  }
}
