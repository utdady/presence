import { useCallback, useEffect, useRef, useState } from 'react'
import {
  applySpeakerRoute,
  canToggleSpeaker,
  resetSpeakerRoute,
} from '../callAudio'
import type { CallStagePhase } from '../components/CallStage'

export type CallMedia = 'audio' | 'video'

export type HubCallSignal =
  | { kind: 'call-offer'; fingerprint: string; media?: CallMedia }
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
  /** STUN + short-lived TURN credentials from the backend. Optional — falls back to STUN-only. */
  getIceServers?: () => Promise<RTCIceServer[]>
}

/** Used when the backend TURN endpoint is unavailable or not configured. */
const FALLBACK_ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.cloudflare.com:3478' },
  { urls: 'stun:stun.l.google.com:19302' },
]

/** Cap video bitrate so quality degrades smoothly instead of spiking on weak links. */
const MAX_VIDEO_BITRATE = 2_000_000

async function tuneVideoSenders(pc: RTCPeerConnection): Promise<void> {
  for (const sender of pc.getSenders()) {
    if (sender.track?.kind !== 'video') continue
    try {
      const params = sender.getParameters()
      if (!params.encodings || params.encodings.length === 0) {
        params.encodings = [{}]
      }
      params.encodings[0].maxBitrate = MAX_VIDEO_BITRATE
      ;(
        params as RTCRtpSendParameters & { degradationPreference?: string }
      ).degradationPreference = 'maintain-framerate'
      await sender.setParameters(params)
    } catch {
      /* pre-negotiation or unsupported — harmless */
    }
  }
}

function isSessionDesc(
  s: RTCSessionDescriptionInit | RTCIceCandidateInit,
): s is RTCSessionDescriptionInit {
  return (
    !!s &&
    'type' in s &&
    (s.type === 'offer' || s.type === 'answer') &&
    typeof (s as RTCSessionDescriptionInit).sdp === 'string'
  )
}

function isIceCandidate(
  s: RTCSessionDescriptionInit | RTCIceCandidateInit,
): s is RTCIceCandidateInit {
  return !!s && typeof (s as RTCIceCandidateInit).candidate === 'string'
}

/** Plain JSON — RTCSessionDescription instances can stringify incompletely. */
function toSdpInit(
  desc: RTCSessionDescriptionInit | RTCSessionDescription | null,
): RTCSessionDescriptionInit {
  if (!desc?.type || !desc.sdp) {
    throw new Error('Missing SDP')
  }
  return { type: desc.type, sdp: desc.sdp }
}

export function usePeerCall(opts: UsePeerCallOptions) {
  const [phase, setPhase] = useState<CallStagePhase>('idle')
  const [media, setMedia] = useState<CallMedia>('audio')
  const [muted, setMuted] = useState(false)
  const [cameraOff, setCameraOff] = useState(false)
  const [speakerOn, setSpeakerOn] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [remoteName, setRemoteName] = useState('')
  const [offerReady, setOfferReady] = useState(false)
  const [poorConnection, setPoorConnection] = useState(false)
  const speakerAvailable = canToggleSpeaker()

  const pcRef = useRef<RTCPeerConnection | null>(null)
  const localStreamRef = useRef<MediaStream | null>(null)
  const remoteStreamRef = useRef<MediaStream | null>(null)
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null)
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null)
  const localVideoRef = useRef<HTMLVideoElement | null>(null)
  const mediaGenRef = useRef(0)
  const mutedRef = useRef(false)
  const cameraOffRef = useRef(false)
  const speakerRef = useRef(false)
  const mediaRef = useRef<CallMedia>('audio')
  const phaseRef = useRef<CallStagePhase>('idle')
  const callPeerRef = useRef<string | null>(null)
  const pendingOfferRef = useRef<RTCSessionDescriptionInit | null>(null)
  const pendingIceRef = useRef<RTCIceCandidateInit[]>([])
  const offerWaitersRef = useRef<Array<() => void>>([])
  const makingOfferRef = useRef(false)
  // Perfect-negotiation roles for mid-call renegotiation: callee is polite.
  const politeRef = useRef(false)
  const iceRestartsRef = useRef(0)
  const disconnectTimerRef = useRef<number | null>(null)
  const statsTimerRef = useRef<number | null>(null)
  const statsPrevRef = useRef<{ lost: number; recv: number } | null>(null)
  const optsRef = useRef(opts)
  optsRef.current = opts
  phaseRef.current = phase
  mediaRef.current = media

  /** Route earpiece vs speaker. Voice defaults earpiece until user enables speaker. */
  const applyOutputRoute = useCallback(() => {
    void applySpeakerRoute(remoteAudioRef.current, speakerRef.current)
  }, [])

  const attachRemoteMedia = useCallback(() => {
    const stream = remoteStreamRef.current
    if (!stream) return
    const video = remoteVideoRef.current
    const audio = remoteAudioRef.current
    // Split for autoplay: muted <video> paints frames; <audio> plays sound.
    if (mediaRef.current === 'video' && video) {
      if (video.srcObject !== stream) video.srcObject = stream
      video.muted = true
      video.setAttribute('playsinline', 'true')
      void video.play().catch(() => {})
    }
    if (audio) {
      if (audio.srcObject !== stream) audio.srcObject = stream
      void audio.play().catch(() => {})
    }
  }, [])

  const attachLocalPreview = useCallback((stream: MediaStream | null) => {
    const el = localVideoRef.current
    if (!el) return
    if (el.srcObject !== stream) el.srcObject = stream
    el.muted = true
    el.setAttribute('playsinline', 'true')
    if (stream) void el.play().catch(() => {})
  }, [])

  /** ~3s loss/RTT sampling driving the "Poor connection" indicator. */
  const pollStats = useCallback(async () => {
    const pc = pcRef.current
    if (!pc || phaseRef.current !== 'in_call') return
    try {
      const stats = await pc.getStats()
      let lost = 0
      let recv = 0
      let rtt: number | null = null
      stats.forEach((report) => {
        const r = report as {
          type: string
          state?: string
          packetsLost?: number
          packetsReceived?: number
          currentRoundTripTime?: number
        }
        if (r.type === 'inbound-rtp') {
          lost += r.packetsLost ?? 0
          recv += r.packetsReceived ?? 0
        }
        if (
          r.type === 'candidate-pair' &&
          r.state === 'succeeded' &&
          typeof r.currentRoundTripTime === 'number'
        ) {
          rtt = Math.max(rtt ?? 0, r.currentRoundTripTime)
        }
      })
      const prev = statsPrevRef.current
      statsPrevRef.current = { lost, recv }
      if (!prev) return
      const dLost = lost - prev.lost
      const dTotal = dLost + (recv - prev.recv)
      const lossRatio = dTotal > 0 ? dLost / dTotal : 0
      setPoorConnection(lossRatio > 0.08 || (rtt !== null && rtt > 0.5))
    } catch {
      /* stats unsupported — indicator stays off */
    }
  }, [])

  const enterInCall = useCallback(() => {
    setPhase('in_call')
    phaseRef.current = 'in_call'
    const pc = pcRef.current
    if (pc) void tuneVideoSenders(pc)
    statsPrevRef.current = null
    if (statsTimerRef.current) window.clearInterval(statsTimerRef.current)
    statsTimerRef.current = window.setInterval(() => void pollStats(), 3000)
    // Voice: force earpiece (loudspeaker only after user tap). Video: keep current route.
    if (mediaRef.current === 'audio') {
      speakerRef.current = false
      setSpeakerOn(false)
    } else {
      // Hands-free is the useful default for video.
      speakerRef.current = true
      setSpeakerOn(true)
    }
    applyOutputRoute()
    attachRemoteMedia()
    attachLocalPreview(localStreamRef.current)
    window.setTimeout(() => {
      attachRemoteMedia()
      attachLocalPreview(localStreamRef.current)
      applyOutputRoute()
    }, 120)
  }, [applyOutputRoute, attachLocalPreview, attachRemoteMedia, pollStats])

  const notifyOfferReady = useCallback(() => {
    setOfferReady(true)
    const waiters = offerWaitersRef.current.splice(0)
    for (const w of waiters) w()
  }, [])

  const waitForRemoteOffer = useCallback((timeoutMs: number) => {
    if (pendingOfferRef.current) return Promise.resolve()
    return new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        offerWaitersRef.current = offerWaitersRef.current.filter((w) => w !== done)
        reject(new Error('Call offer timed out — try again'))
      }, timeoutMs)
      const done = () => {
        window.clearTimeout(timer)
        resolve()
      }
      offerWaitersRef.current.push(done)
      if (pendingOfferRef.current) {
        offerWaitersRef.current = offerWaitersRef.current.filter((w) => w !== done)
        window.clearTimeout(timer)
        resolve()
      }
    })
  }, [])

  const cleanup = useCallback(() => {
    mediaGenRef.current += 1
    makingOfferRef.current = false
    politeRef.current = false
    iceRestartsRef.current = 0
    if (disconnectTimerRef.current) {
      window.clearTimeout(disconnectTimerRef.current)
      disconnectTimerRef.current = null
    }
    if (statsTimerRef.current) {
      window.clearInterval(statsTimerRef.current)
      statsTimerRef.current = null
    }
    statsPrevRef.current = null
    setPoorConnection(false)
    const pc = pcRef.current
    pcRef.current = null
    if (pc) {
      pc.onicecandidate = null
      pc.ontrack = null
      pc.onconnectionstatechange = null
      pc.oniceconnectionstatechange = null
      pc.onnegotiationneeded = null
      pc.close()
    }
    localStreamRef.current?.getTracks().forEach((t) => t.stop())
    localStreamRef.current = null
    remoteStreamRef.current = null
    if (remoteAudioRef.current) remoteAudioRef.current.srcObject = null
    if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null
    if (localVideoRef.current) localVideoRef.current.srcObject = null
    pendingOfferRef.current = null
    pendingIceRef.current = []
    offerWaitersRef.current = []
    callPeerRef.current = null
    setOfferReady(false)
    setMuted(false)
    mutedRef.current = false
    setCameraOff(false)
    cameraOffRef.current = false
    speakerRef.current = false
    setSpeakerOn(false)
    setMedia('audio')
    mediaRef.current = 'audio'
    void resetSpeakerRoute()
  }, [])

  const flushPendingIce = useCallback(async (pc: RTCPeerConnection) => {
    const pending = pendingIceRef.current.splice(0)
    for (const c of pending) {
      try {
        await pc.addIceCandidate(c)
      } catch {
        /* ignore stale */
      }
    }
  }, [])

  /** Recover from network changes (wifi→cellular etc.) before giving up. */
  const requestIceRestart = useCallback((pc: RTCPeerConnection) => {
    if (pc !== pcRef.current) return
    if (phaseRef.current !== 'in_call') return
    if (iceRestartsRef.current >= 2) return
    iceRestartsRef.current += 1
    // Fires negotiationneeded → a fresh offer goes out over the signal channel.
    pc.restartIce()
  }, [])

  const ensurePc = useCallback(
    async (wantVideo: boolean) => {
      if (pcRef.current) return pcRef.current
      const peerId = callPeerRef.current
      if (!peerId) throw new Error('No peer')

      const gen = ++mediaGenRef.current
      let iceServers = FALLBACK_ICE_SERVERS
      if (optsRef.current.getIceServers) {
        try {
          iceServers = await optsRef.current.getIceServers()
        } catch {
          /* backend unreachable — STUN-only still allows direct P2P */
        }
      }
      if (gen !== mediaGenRef.current || pcRef.current) {
        throw new Error('Call cancelled')
      }

      const pc = new RTCPeerConnection({ iceServers })
      pcRef.current = pc

      pc.onicecandidate = (ev) => {
        const to = callPeerRef.current
        if (!ev.candidate || !to) return
        optsRef.current.sendSignal(to, {
          kind: 'webrtc-signal',
          signal: ev.candidate.toJSON(),
        })
      }

      pc.ontrack = (ev) => {
        const inbound = ev.streams[0]
        if (inbound) {
          remoteStreamRef.current = inbound
        } else {
          if (!remoteStreamRef.current) {
            remoteStreamRef.current = new MediaStream()
          }
          if (!remoteStreamRef.current.getTracks().includes(ev.track)) {
            remoteStreamRef.current.addTrack(ev.track)
          }
        }
        attachRemoteMedia()
      }

      pc.onconnectionstatechange = () => {
        if (pc !== pcRef.current) return
        if (pc.connectionState === 'connected') {
          iceRestartsRef.current = 0
          setError(null)
          void tuneVideoSenders(pc)
          return
        }
        if (pc.connectionState === 'failed') {
          if (phaseRef.current === 'in_call' && iceRestartsRef.current < 2) {
            requestIceRestart(pc)
            return
          }
          setError('Could not connect — check network / try again')
          // Don't auto-teardown immediately; leave UI so user can End.
        }
      }

      pc.oniceconnectionstatechange = () => {
        if (pc !== pcRef.current) return
        const st = pc.iceConnectionState
        if (st === 'connected' || st === 'completed') {
          if (disconnectTimerRef.current) {
            window.clearTimeout(disconnectTimerRef.current)
            disconnectTimerRef.current = null
          }
          return
        }
        // 'disconnected' often self-heals — restart ICE only if it persists.
        if (st === 'disconnected' && !disconnectTimerRef.current) {
          disconnectTimerRef.current = window.setTimeout(() => {
            disconnectTimerRef.current = null
            if (pc === pcRef.current && pc.iceConnectionState === 'disconnected') {
              requestIceRestart(pc)
            }
          }, 3000)
        }
      }

      // Renegotiation only (ICE restarts). The initial offer stays manual in
      // startCall/acceptCall, so this must not fire during first setup.
      pc.onnegotiationneeded = () => {
        if (pc !== pcRef.current) return
        if (phaseRef.current !== 'in_call') return
        void (async () => {
          try {
            makingOfferRef.current = true
            await pc.setLocalDescription()
            const to = callPeerRef.current
            if (to && pc.localDescription) {
              optsRef.current.sendSignal(to, {
                kind: 'webrtc-signal',
                signal: toSdpInit(pc.localDescription),
              })
            }
          } catch {
            /* renegotiation failed — connection monitor will retry/report */
          } finally {
            makingOfferRef.current = false
          }
        })()
      }

      let stream: MediaStream
      try {
        // `ideal` constraints never hard-fail — browsers best-effort match them.
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
          video: wantVideo
            ? {
                facingMode: 'user',
                width: { ideal: 1280 },
                height: { ideal: 720 },
                frameRate: { ideal: 30 },
              }
            : false,
        })
      } catch (e) {
        if (wantVideo) {
          try {
            stream = await navigator.mediaDevices.getUserMedia({
              audio: true,
              video: true,
            })
          } catch (e2) {
            if (pcRef.current === pc) {
              pcRef.current = null
              pc.close()
            }
            const msg =
              e2 instanceof Error ? e2.message : 'Camera / mic permission denied'
            throw new Error(msg)
          }
        } else {
          if (pcRef.current === pc) {
            pcRef.current = null
            pc.close()
          }
          throw e
        }
      }
      if (gen !== mediaGenRef.current || pcRef.current !== pc) {
        stream.getTracks().forEach((t) => t.stop())
        throw new Error('Call cancelled')
      }
      localStreamRef.current = stream
      if (wantVideo) attachLocalPreview(stream)
      for (const track of stream.getTracks()) pc.addTrack(track, stream)
      return pc
    },
    [attachLocalPreview, attachRemoteMedia, requestIceRestart],
  )

  useEffect(() => {
    return optsRef.current.onRemoteSignal((from, signal) => {
      void (async () => {
        // Once a call peer is chosen, only that peer's signals apply.
        // Never gate on the open chat — that dropped SDP/ICE after ringtone.
        if (callPeerRef.current && from !== callPeerRef.current) return

        if (signal.kind === 'call-offer') {
          if (phaseRef.current !== 'idle' && phaseRef.current !== 'incoming') {
            // Busy — reject politely
            optsRef.current.sendSignal(from, { kind: 'call-reject' })
            return
          }
          const m: CallMedia = signal.media === 'video' ? 'video' : 'audio'
          mediaRef.current = m
          setMedia(m)
          setRemoteName(from)
          callPeerRef.current = from
          politeRef.current = true
          setOfferReady(!!pendingOfferRef.current)
          setPhase('incoming')
          phaseRef.current = 'incoming'
          return
        }

        if (signal.kind === 'call-reject' || signal.kind === 'call-end') {
          cleanup()
          setPhase('idle')
          phaseRef.current = 'idle'
          return
        }

        if (signal.kind === 'call-answer') {
          if (phaseRef.current !== 'outgoing' && phaseRef.current !== 'in_call') {
            return
          }
          enterInCall()
          return
        }

        if (signal.kind !== 'webrtc-signal') return
        const s = signal.signal

        if (isSessionDesc(s) && s.type === 'offer') {
          // --- Mid-call renegotiation offer (ICE restart / network change).
          // Perfect-negotiation: impolite (caller) ignores colliding offers;
          // polite (callee) rolls back via setRemoteDescription.
          const pc = pcRef.current
          if (pc && phaseRef.current === 'in_call') {
            const collision =
              makingOfferRef.current || pc.signalingState !== 'stable'
            if (!politeRef.current && collision) return
            try {
              await pc.setRemoteDescription(s)
              await flushPendingIce(pc)
              await pc.setLocalDescription()
              const to = callPeerRef.current
              if (to && pc.localDescription) {
                optsRef.current.sendSignal(to, {
                  kind: 'webrtc-signal',
                  signal: toSdpInit(pc.localDescription),
                })
              }
            } catch {
              /* stale renegotiation — connection monitor handles recovery */
            }
            return
          }

          // --- Initial SDP offer (callee buffers until Accept) ---
          if (!callPeerRef.current) callPeerRef.current = from
          setRemoteName((n) => n || from)
          politeRef.current = true
          pendingOfferRef.current = s
          if (phaseRef.current === 'idle') {
            setPhase('incoming')
            phaseRef.current = 'incoming'
          }
          notifyOfferReady()
          return
        }

        // Buffer ICE until we have a PC *and* a remote description.
        // (Caller often receives callee ICE before the answer SDP.)
        if (isIceCandidate(s)) {
          const pc = pcRef.current
          if (!pc || !pc.remoteDescription) {
            pendingIceRef.current.push(s)
            return
          }
          try {
            await pc.addIceCandidate(s)
          } catch {
            /* ignore stale */
          }
          return
        }

        if (isSessionDesc(s) && s.type === 'answer') {
          const pc = pcRef.current
          if (!pc) return
          if (
            pc.signalingState === 'have-local-offer' ||
            pc.signalingState === 'have-remote-pranswer'
          ) {
            await pc.setRemoteDescription(s)
            await flushPendingIce(pc)
            // Renegotiation answers must not re-run in-call setup (speaker route etc.).
            if (phaseRef.current !== 'in_call') enterInCall()
          }
        }
      })()
    })
  }, [attachRemoteMedia, cleanup, enterInCall, flushPendingIce, notifyOfferReady])

  useEffect(() => () => cleanup(), [cleanup])

  const startCall = useCallback(
    async (want: CallMedia = 'audio') => {
      const peerId = optsRef.current.peerId
      if (!peerId || !optsRef.current.peerOnline) {
        setError('Peer is offline')
        return
      }
      if (phaseRef.current !== 'idle') return
      setError(null)
      mediaRef.current = want
      setMedia(want)
      callPeerRef.current = peerId
      politeRef.current = false
      setRemoteName(peerId)
      setOfferReady(false)
      setPhase('outgoing')
      phaseRef.current = 'outgoing'
      try {
        makingOfferRef.current = true
        const pc = await ensurePc(want === 'video')
        const offer = await pc.createOffer({
          offerToReceiveAudio: true,
          offerToReceiveVideo: want === 'video',
        })
        await pc.setLocalDescription(offer)
        const local = toSdpInit(pc.localDescription ?? offer)
        makingOfferRef.current = false
        // Ring + SDP together so Accept never races an empty offer.
        const okRing = optsRef.current.sendSignal(peerId, {
          kind: 'call-offer',
          fingerprint: optsRef.current.myFingerprint,
          media: want,
        })
        const okSdp = optsRef.current.sendSignal(peerId, {
          kind: 'webrtc-signal',
          signal: local,
        })
        if (!okRing || !okSdp) {
          throw new Error('Could not reach peer — no session key yet')
        }
        // Local self-view may mount after getUserMedia resolves.
        attachLocalPreview(localStreamRef.current)
        window.setTimeout(() => attachLocalPreview(localStreamRef.current), 120)
      } catch (e) {
        makingOfferRef.current = false
        cleanup()
        setError(e instanceof Error ? e.message : 'Call failed')
        setPhase('idle')
        phaseRef.current = 'idle'
      }
    },
    [attachLocalPreview, cleanup, ensurePc],
  )

  const acceptCall = useCallback(async () => {
    const peerId = callPeerRef.current
    if (!peerId) return
    if (phaseRef.current !== 'incoming') return
    setError(null)
    try {
      await waitForRemoteOffer(25_000)
      const offer = pendingOfferRef.current
      if (!offer) throw new Error('No offer yet — try again')
      pendingOfferRef.current = null

      const wantVideo = mediaRef.current === 'video'
      const pc = await ensurePc(wantVideo)

      await pc.setRemoteDescription(toSdpInit(offer))
      await flushPendingIce(pc)
      const answer = await pc.createAnswer()
      await pc.setLocalDescription(answer)
      const local = toSdpInit(pc.localDescription ?? answer)

      const okSdp = optsRef.current.sendSignal(peerId, {
        kind: 'webrtc-signal',
        signal: local,
      })
      const okAns = optsRef.current.sendSignal(peerId, { kind: 'call-answer' })
      if (!okSdp || !okAns) throw new Error('Could not reach peer — no session key yet')

      enterInCall()
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Accept failed'
      cleanup()
      setError(msg)
      setPhase('idle')
      phaseRef.current = 'idle'
    }
  }, [
    cleanup,
    ensurePc,
    enterInCall,
    flushPendingIce,
    waitForRemoteOffer,
  ])

  const rejectCall = useCallback(() => {
    const peerId = callPeerRef.current
    if (peerId) optsRef.current.sendSignal(peerId, { kind: 'call-reject' })
    cleanup()
    setPhase('idle')
    phaseRef.current = 'idle'
  }, [cleanup])

  const endCall = useCallback(() => {
    const peerId = callPeerRef.current
    if (peerId) optsRef.current.sendSignal(peerId, { kind: 'call-end' })
    cleanup()
    setPhase('idle')
    phaseRef.current = 'idle'
  }, [cleanup])

  const toggleMute = useCallback(() => {
    const next = !mutedRef.current
    mutedRef.current = next
    setMuted(next)
    localStreamRef.current?.getAudioTracks().forEach((t) => {
      t.enabled = !next
    })
  }, [])

  const toggleCamera = useCallback(() => {
    if (mediaRef.current !== 'video') return
    const next = !cameraOffRef.current
    cameraOffRef.current = next
    setCameraOff(next)
    localStreamRef.current?.getVideoTracks().forEach((t) => {
      t.enabled = !next
    })
  }, [])

  const toggleSpeaker = useCallback(() => {
    const next = !speakerRef.current
    speakerRef.current = next
    setSpeakerOn(next)
    void applySpeakerRoute(remoteAudioRef.current, next)
  }, [])

  const setRemoteAudioEl = useCallback(
    (el: HTMLAudioElement | null) => {
      remoteAudioRef.current = el
      attachRemoteMedia()
      // Always re-apply route so Android earpiece is forced, not only when speaker is on.
      if (el && phaseRef.current === 'in_call') {
        void applySpeakerRoute(el, speakerRef.current)
      }
    },
    [attachRemoteMedia],
  )

  const setRemoteVideoEl = useCallback(
    (el: HTMLVideoElement | null) => {
      remoteVideoRef.current = el
      if (el) attachRemoteMedia()
    },
    [attachRemoteMedia],
  )

  const setLocalVideoEl = useCallback(
    (el: HTMLVideoElement | null) => {
      localVideoRef.current = el
      if (el && localStreamRef.current) attachLocalPreview(localStreamRef.current)
    },
    [attachLocalPreview],
  )

  return {
    phase,
    media,
    muted,
    cameraOff,
    speakerOn,
    speakerAvailable,
    offerReady,
    poorConnection,
    error,
    remoteName,
    startCall,
    acceptCall,
    rejectCall,
    endCall,
    toggleMute,
    toggleCamera,
    toggleSpeaker,
    setRemoteAudioEl,
    setRemoteVideoEl,
    setLocalVideoEl,
  }
}
