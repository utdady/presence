import { useCallback, useEffect, useRef, useState } from 'react'
import type { CallStagePhase } from '../components/CallStage'

export type HubCallSignal =
  | { kind: 'call-offer'; fingerprint: string }
  | { kind: 'call-answer' }
  | { kind: 'call-reject' }
  | { kind: 'call-end' }
  | {
      kind: 'webrtc-signal'
      signal: RTCSessionDescriptionInit | RTCIceCandidateInit
    }

interface UsePeerCallOptions {
  peerId: string | null
  peerOnline: boolean
  myFingerprint: string
  sendSignal: (peerId: string, signal: HubCallSignal) => boolean
  onRemoteSignal: (
    handler: (from: string, signal: HubCallSignal) => void,
  ) => () => void
}

export function usePeerCall(opts: UsePeerCallOptions) {
  const [phase, setPhase] = useState<CallStagePhase>('idle')
  const [muted, setMuted] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [remoteName, setRemoteName] = useState('')

  const pcRef = useRef<RTCPeerConnection | null>(null)
  const localStreamRef = useRef<MediaStream | null>(null)
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null)
  const mediaGenRef = useRef(0)
  const mutedRef = useRef(false)
  const phaseRef = useRef<CallStagePhase>('idle')
  const peerIdRef = useRef(opts.peerId)
  const pendingOfferRef = useRef<RTCSessionDescriptionInit | null>(null)
  const pendingIceRef = useRef<RTCIceCandidateInit[]>([])
  const optsRef = useRef(opts)
  optsRef.current = opts
  peerIdRef.current = opts.peerId
  phaseRef.current = phase

  const cleanup = useCallback(() => {
    mediaGenRef.current += 1
    pcRef.current?.close()
    pcRef.current = null
    localStreamRef.current?.getTracks().forEach((t) => t.stop())
    localStreamRef.current = null
    if (remoteAudioRef.current) remoteAudioRef.current.srcObject = null
    pendingOfferRef.current = null
    pendingIceRef.current = []
    setMuted(false)
    mutedRef.current = false
  }, [])

  const ensurePc = useCallback(async () => {
    if (pcRef.current) return pcRef.current
    const peerId = peerIdRef.current
    if (!peerId) throw new Error('No peer')
    const pc = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
    })
    pcRef.current = pc
    pc.onicecandidate = (ev) => {
      if (!ev.candidate || !peerIdRef.current) return
      optsRef.current.sendSignal(peerIdRef.current, {
        kind: 'webrtc-signal',
        signal: ev.candidate.toJSON(),
      })
    }
    pc.ontrack = (ev) => {
      const audio = remoteAudioRef.current
      if (!audio) return
      audio.srcObject = ev.streams[0] ?? new MediaStream([ev.track])
      void audio.play().catch(() => {})
    }
    const gen = ++mediaGenRef.current
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    if (gen !== mediaGenRef.current) {
      stream.getTracks().forEach((t) => t.stop())
      throw new Error('Call cancelled')
    }
    localStreamRef.current = stream
    for (const track of stream.getTracks()) pc.addTrack(track, stream)
    return pc
  }, [])

  const flushPendingIce = useCallback(async (pc: RTCPeerConnection) => {
    const pending = pendingIceRef.current
    pendingIceRef.current = []
    for (const c of pending) {
      try {
        await pc.addIceCandidate(c)
      } catch {
        /* ignore */
      }
    }
  }, [])

  useEffect(() => {
    return opts.onRemoteSignal((from, signal) => {
      if (optsRef.current.peerId && from !== optsRef.current.peerId) {
        // Still accept incoming offers from other peers when idle
        if (phaseRef.current !== 'idle') return
        const isOffer =
          signal.kind === 'call-offer' ||
          (signal.kind === 'webrtc-signal' &&
            'type' in signal.signal &&
            signal.signal.type === 'offer')
        if (!isOffer) return
      }
      void (async () => {
        if (signal.kind === 'call-offer') {
          setRemoteName(from)
          peerIdRef.current = from
          setPhase('incoming')
          return
        }
        if (signal.kind === 'call-reject' || signal.kind === 'call-end') {
          cleanup()
          setPhase('idle')
          return
        }
        if (signal.kind === 'call-answer') {
          if (phaseRef.current !== 'outgoing') return
          setPhase('in_call')
          return
        }
        if (signal.kind === 'webrtc-signal') {
          const s = signal.signal
          // Buffer SDP/ICE until the user accepts — do not open mic early.
          // Also buffer while idle in case the offer races ahead of call-offer.
          if (
            phaseRef.current === 'incoming' ||
            phaseRef.current === 'idle'
          ) {
            if ('candidate' in s && s.candidate !== undefined) {
              pendingIceRef.current.push(s as RTCIceCandidateInit)
              return
            }
            if ('type' in s && s.type === 'offer') {
              pendingOfferRef.current = s as RTCSessionDescriptionInit
              if (phaseRef.current === 'idle') {
                setRemoteName(from)
                peerIdRef.current = from
                setPhase('incoming')
              }
            }
            return
          }
          if (phaseRef.current !== 'outgoing' && phaseRef.current !== 'in_call') {
            return
          }
          const pc = pcRef.current
          if (!pc) {
            if ('candidate' in s && s.candidate !== undefined) {
              pendingIceRef.current.push(s as RTCIceCandidateInit)
            } else if ('type' in s && s.type === 'offer') {
              pendingOfferRef.current = s as RTCSessionDescriptionInit
            }
            return
          }
          if ('candidate' in s && s.candidate !== undefined) {
            try {
              await pc.addIceCandidate(s as RTCIceCandidateInit)
            } catch {
              /* ignore */
            }
            return
          }
          if ('type' in s && (s.type === 'offer' || s.type === 'answer')) {
            const desc = s as RTCSessionDescriptionInit
            if (desc.type === 'answer') {
              await pc.setRemoteDescription(desc)
              await flushPendingIce(pc)
            }
          }
        }
      })()
    })
  }, [cleanup, flushPendingIce, opts])

  useEffect(() => () => cleanup(), [cleanup])

  const startCall = useCallback(async () => {
    const peerId = optsRef.current.peerId
    if (!peerId || !optsRef.current.peerOnline) {
      setError('Peer is offline')
      return
    }
    setError(null)
    setPhase('outgoing')
    setRemoteName(peerId)
    try {
      optsRef.current.sendSignal(peerId, {
        kind: 'call-offer',
        fingerprint: optsRef.current.myFingerprint,
      })
      const pc = await ensurePc()
      const offer = await pc.createOffer()
      await pc.setLocalDescription(offer)
      optsRef.current.sendSignal(peerId, {
        kind: 'webrtc-signal',
        signal: offer,
      })
    } catch (e) {
      cleanup()
      setError(e instanceof Error ? e.message : 'Call failed')
      setPhase('idle')
    }
  }, [cleanup, ensurePc])

  const acceptCall = useCallback(async () => {
    const peerId = peerIdRef.current
    if (!peerId) return
    setError(null)
    try {
      optsRef.current.sendSignal(peerId, { kind: 'call-answer' })
      const pc = await ensurePc()
      const offer = pendingOfferRef.current
      pendingOfferRef.current = null
      if (!offer) {
        throw new Error('No offer yet — try again')
      }
      await pc.setRemoteDescription(offer)
      const answer = await pc.createAnswer()
      await pc.setLocalDescription(answer)
      optsRef.current.sendSignal(peerId, {
        kind: 'webrtc-signal',
        signal: answer,
      })
      await flushPendingIce(pc)
      setPhase('in_call')
    } catch (e) {
      cleanup()
      setError(e instanceof Error ? e.message : 'Accept failed')
      setPhase('idle')
    }
  }, [cleanup, ensurePc, flushPendingIce])

  const rejectCall = useCallback(() => {
    const peerId = peerIdRef.current
    if (peerId) optsRef.current.sendSignal(peerId, { kind: 'call-reject' })
    cleanup()
    setPhase('idle')
  }, [cleanup])

  const endCall = useCallback(() => {
    const peerId = peerIdRef.current
    if (peerId) optsRef.current.sendSignal(peerId, { kind: 'call-end' })
    cleanup()
    setPhase('idle')
  }, [cleanup])

  const toggleMute = useCallback(() => {
    const next = !mutedRef.current
    mutedRef.current = next
    setMuted(next)
    localStreamRef.current?.getAudioTracks().forEach((t) => {
      t.enabled = !next
    })
  }, [])

  const setRemoteAudioEl = useCallback((el: HTMLAudioElement | null) => {
    remoteAudioRef.current = el
  }, [])

  return {
    phase,
    muted,
    error,
    remoteName,
    startCall,
    acceptCall,
    rejectCall,
    endCall,
    toggleMute,
    setRemoteAudioEl,
  }
}
