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

  const sessionKeyRef = useRef<Uint8Array | null>(null)
  const pcRef = useRef<RTCPeerConnection | null>(null)
  const localStreamRef = useRef<MediaStream | null>(null)
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null)
  const makingOfferRef = useRef(false)
  const politeRef = useRef(false)
  const ignoreOfferRef = useRef(false)
  const optsRef = useRef(opts)
  optsRef.current = opts

  const cleanupMedia = useCallback(() => {
    pcRef.current?.close()
    pcRef.current = null
    localStreamRef.current?.getTracks().forEach((t) => t.stop())
    localStreamRef.current = null
    if (remoteAudioRef.current) {
      remoteAudioRef.current.srcObject = null
    }
    makingOfferRef.current = false
    ignoreOfferRef.current = false
  }, [])

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

  const ensurePc = useCallback(async () => {
    if (pcRef.current) return pcRef.current
    const pc = new RTCPeerConnection({ iceServers: [] })
    pcRef.current = pc

    pc.onicecandidate = (ev) => {
      if (!ev.candidate) return
      void sendSignal({
        type: 'webrtc-signal',
        signal: ev.candidate.toJSON(),
      }).catch(() => {})
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

  const handlePlain = useCallback(
    async (plain: NearbyPlainSignal) => {
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
            await sendSignal({
              type: 'webrtc-signal',
              signal: answer,
            })
          }
        } else if ('candidate' in signal || 'sdpMid' in signal) {
          try {
            await pc.addIceCandidate(signal as RTCIceCandidateInit)
          } catch {
            if (!ignoreOfferRef.current) throw new Error('ICE failed')
          }
        }
      }
    },
    [cleanupMedia, ensurePc, sendSignal],
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
        // Lexicographic compare of public keys decides polite peer
        politeRef.current = optsRef.current.publicKey > hello.publicKey
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
      const pc = await ensurePc()
      makingOfferRef.current = true
      const offer = await pc.createOffer()
      await pc.setLocalDescription(offer)
      await sendSignal({ type: 'webrtc-signal', signal: offer })
      makingOfferRef.current = false
    } catch (e) {
      makingOfferRef.current = false
      cleanupMedia()
      setError(e instanceof Error ? e.message : 'Call failed')
      setPhase('ready')
    }
  }, [cleanupMedia, ensurePc, sendSignal])

  const acceptCall = useCallback(async () => {
    setError(null)
    try {
      await ensurePc()
      await sendSignal({ type: 'call-answer' })
      setPhase('in_call')
      setStatus('In call')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Accept failed')
      setPhase('ready')
    }
  }, [ensurePc, sendSignal])

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
    setMuted(false)
    setPhase(sessionKeyRef.current ? 'ready' : 'scanning')
    setStatus('Call ended')
  }, [cleanupMedia, sendSignal])

  const toggleMute = useCallback(() => {
    const stream = localStreamRef.current
    if (!stream) return
    const next = !muted
    for (const track of stream.getAudioTracks()) {
      track.enabled = !next
    }
    setMuted(next)
  }, [muted])

  const setRemoteAudioEl = useCallback((el: HTMLAudioElement | null) => {
    remoteAudioRef.current = el
  }, [])

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
    startScanning,
    stopScanning,
    connectTo,
    startCall,
    acceptCall,
    rejectCall,
    endCall,
    toggleMute,
    setRemoteAudioEl,
  }
}