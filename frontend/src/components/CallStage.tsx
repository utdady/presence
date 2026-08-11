import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import {
  startRingback,
  startRingtone,
  stopCallSounds,
} from '../callSounds'
import {
  hapticHeavy,
  hapticLight,
  hapticMedium,
  hapticSelection,
  hapticSuccess,
  hapticWarning,
} from '../haptics'
import type { CallMedia } from '../hooks/usePeerCall'
import type { NearbyCallPhase } from '../nearby/types'

export type CallStagePhase =
  | 'idle'
  | 'outgoing'
  | 'incoming'
  | 'in_call'
  | 'ended'

interface CallStageProps {
  open: boolean
  phase: CallStagePhase | NearbyCallPhase
  peerName: string
  subtitle?: string
  media?: CallMedia
  muted: boolean
  cameraOff?: boolean
  speakerOn?: boolean
  speakerAvailable?: boolean
  catchingUp?: boolean
  /** False until the encrypted WebRTC offer has arrived (Accept should wait). */
  offerReady?: boolean
  /** High packet loss / RTT detected — show a subtle in-call warning. */
  poorConnection?: boolean
  error?: string | null
  /** When true, show the mini return-to-call bar instead of the full stage. */
  minimized?: boolean
  onMinimize?: () => void
  onExpand?: () => void
  onAccept: () => void
  onReject: () => void
  onEnd: () => void
  onToggleMute: () => void
  onToggleCamera?: () => void
  onToggleSpeaker?: () => void
  onDismiss?: () => void
  onBindRemoteVideo?: (el: HTMLVideoElement | null) => void
  onBindLocalVideo?: (el: HTMLVideoElement | null) => void
}

const HEADPHONES_TIP_KEY = 'presence.callHeadphonesTip.v1'

type PipCorner = 'tl' | 'tr' | 'bl' | 'br'

function isActivePhase(phase: string): boolean {
  return (
    phase === 'outgoing' ||
    phase === 'incoming' ||
    phase === 'in_call'
  )
}

function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${s.toString().padStart(2, '0')}`
}

function SignalBars({ weak }: { weak: boolean }) {
  return (
    <svg
      className="call-stage-signal"
      width="18"
      height="14"
      viewBox="0 0 18 14"
      aria-hidden
    >
      <rect x="1" y="10" width="3" height="4" rx="0.5" fill="currentColor" opacity={0.9} />
      <rect x="5.5" y="7" width="3" height="7" rx="0.5" fill="currentColor" opacity={0.9} />
      <rect
        x="10"
        y="4"
        width="3"
        height="10"
        rx="0.5"
        fill="currentColor"
        opacity={weak ? 0.25 : 0.9}
      />
      <rect
        x="14.5"
        y="1"
        width="3"
        height="13"
        rx="0.5"
        fill="currentColor"
        opacity={weak ? 0.25 : 0.9}
        className={weak ? 'call-stage-signal-bar--pulse' : undefined}
      />
    </svg>
  )
}

function useCallElapsed(active: boolean): string | null {
  const startedRef = useRef<number | null>(null)
  const [label, setLabel] = useState<string | null>(null)

  useEffect(() => {
    if (!active) {
      startedRef.current = null
      setLabel(null)
      return
    }
    if (startedRef.current == null) startedRef.current = Date.now()
    const tick = () => {
      const start = startedRef.current
      if (start != null) setLabel(formatElapsed(Date.now() - start))
    }
    tick()
    const id = window.setInterval(tick, 1000)
    return () => window.clearInterval(id)
  }, [active])

  return label
}

function snapCorner(x: number, y: number, w: number, h: number): PipCorner {
  const midX = w / 2
  const midY = h / 2
  if (x < midX && y < midY) return 'tl'
  if (x >= midX && y < midY) return 'tr'
  if (x < midX && y >= midY) return 'bl'
  return 'br'
}

export function CallStage({
  open,
  phase,
  peerName,
  subtitle,
  media = 'audio',
  muted,
  cameraOff = false,
  speakerOn = false,
  speakerAvailable = false,
  catchingUp,
  offerReady = true,
  poorConnection = false,
  error,
  minimized = false,
  onMinimize,
  onExpand,
  onAccept,
  onReject,
  onEnd,
  onToggleMute,
  onToggleCamera,
  onToggleSpeaker,
  onDismiss,
  onBindRemoteVideo,
  onBindLocalVideo,
}: CallStageProps) {
  const remoteRef = useRef<HTMLVideoElement>(null)
  const localRef = useRef<HTMLVideoElement>(null)
  const bindRemoteRef = useRef(onBindRemoteVideo)
  const bindLocalRef = useRef(onBindLocalVideo)
  bindRemoteRef.current = onBindRemoteVideo
  bindLocalRef.current = onBindLocalVideo
  const isVideo = media === 'video'
  const active = open && isActivePhase(phase)
  const elapsed = useCallElapsed(active && phase === 'in_call')
  const [showHeadphonesTip, setShowHeadphonesTip] = useState(false)
  const [pipCorner, setPipCorner] = useState<PipCorner>('tr')
  const [pipDragging, setPipDragging] = useState(false)
  const [pipOffset, setPipOffset] = useState<{ x: number; y: number } | null>(
    null,
  )
  const dragRef = useRef<{
    pointerId: number
    startX: number
    startY: number
    origLeft: number
    origTop: number
  } | null>(null)
  const prevPhaseRef = useRef(phase)
  const prevPoorRef = useRef(false)

  // Bind once while video UI is open — do not rebind on phase (that briefly
  // nulls the elements and drops remote video right after Accept).
  useEffect(() => {
    if (!open || !isVideo || minimized) return
    bindRemoteRef.current?.(remoteRef.current)
    bindLocalRef.current?.(localRef.current)
    return () => {
      bindRemoteRef.current?.(null)
      bindLocalRef.current?.(null)
    }
  }, [open, isVideo, minimized])

  // Ringtone / ringback — stop the instant phase leaves ringing states.
  useEffect(() => {
    if (!active || minimized) {
      stopCallSounds()
      return
    }
    if (phase === 'incoming') startRingtone()
    else if (phase === 'outgoing') startRingback()
    else stopCallSounds()
    return () => stopCallSounds()
  }, [active, phase, minimized])

  // Connected haptic + one-time headphones tip.
  useEffect(() => {
    const prev = prevPhaseRef.current
    prevPhaseRef.current = phase
    if (phase === 'in_call' && prev !== 'in_call') {
      hapticSuccess()
      try {
        if (!localStorage.getItem(HEADPHONES_TIP_KEY)) {
          setShowHeadphonesTip(true)
          localStorage.setItem(HEADPHONES_TIP_KEY, '1')
        }
      } catch {
        /* private mode */
      }
    }
    if (!isActivePhase(phase)) setShowHeadphonesTip(false)
  }, [phase])

  useEffect(() => {
    if (poorConnection && phase === 'in_call' && !prevPoorRef.current) {
      hapticWarning()
    }
    prevPoorRef.current = poorConnection && phase === 'in_call'
  }, [poorConnection, phase])

  if (!active) return null

  const initial = (peerName || '?').slice(0, 1).toUpperCase()
  const canMinimize =
    (phase === 'in_call' || phase === 'outgoing') && !!onMinimize

  if (minimized && onExpand) {
    return (
      <button
        type="button"
        className="call-mini-bar"
        onClick={() => {
          hapticLight()
          onExpand()
        }}
      >
        <span className="call-mini-bar-dot" aria-hidden />
        <span className="call-mini-bar-text">
          {phase === 'outgoing'
            ? `Calling ${peerName || 'peer'}…`
            : `Tap to return to call${elapsed ? ` · ${elapsed}` : ''}`}
        </span>
        {poorConnection && phase === 'in_call' && (
          <span className="call-mini-bar-quality" aria-label="Poor connection">
            <SignalBars weak />
          </span>
        )}
      </button>
    )
  }

  const title =
    phase === 'incoming'
      ? isVideo
        ? 'Incoming video call'
        : 'Incoming call'
      : phase === 'outgoing'
        ? isVideo
          ? 'Video calling…'
          : 'Calling…'
        : catchingUp
          ? 'Connected — catching up'
          : isVideo
            ? 'Video call'
            : 'In call'

  const onPipPointerDown = (e: ReactPointerEvent<HTMLVideoElement>) => {
    if (phase !== 'in_call') return
    const el = e.currentTarget
    const rect = el.getBoundingClientRect()
    dragRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      origLeft: rect.left,
      origTop: rect.top,
    }
    el.setPointerCapture(e.pointerId)
    setPipDragging(true)
    setPipOffset({ x: rect.left, y: rect.top })
  }

  const onPipPointerMove = (e: ReactPointerEvent<HTMLVideoElement>) => {
    const d = dragRef.current
    if (!d || e.pointerId !== d.pointerId) return
    const dx = e.clientX - d.startX
    const dy = e.clientY - d.startY
    setPipOffset({ x: d.origLeft + dx, y: d.origTop + dy })
  }

  const onPipPointerUp = (e: ReactPointerEvent<HTMLVideoElement>) => {
    const d = dragRef.current
    if (!d || e.pointerId !== d.pointerId) return
    const el = e.currentTarget
    const rect = el.getBoundingClientRect()
    const cx = rect.left + rect.width / 2
    const cy = rect.top + rect.height / 2
    setPipCorner(snapCorner(cx, cy, window.innerWidth, window.innerHeight))
    setPipDragging(false)
    setPipOffset(null)
    dragRef.current = null
    hapticSelection()
  }

  const pipStyle =
    pipDragging && pipOffset
      ? {
          left: pipOffset.x,
          top: pipOffset.y,
          right: 'auto',
          bottom: 'auto',
          transition: 'none',
        }
      : undefined

  return (
    <div
      className={`call-stage${isVideo ? ' call-stage--video' : ' call-stage--audio'}${isVideo && phase === 'in_call' ? ' call-stage--video-live' : ''}`}
      role="dialog"
      aria-label={title}
    >
      <div className="call-stage-bg" aria-hidden />
      {canMinimize && (
        <button
          type="button"
          className="call-stage-minimize"
          aria-label="Minimize call"
          onClick={() => {
            hapticLight()
            onMinimize?.()
          }}
        >
          ▾
        </button>
      )}
      {isVideo && (
        <>
          <video
            ref={remoteRef}
            className="call-stage-remote-video"
            autoPlay
            playsInline
            muted
          />
          <video
            ref={localRef}
            className={`call-stage-local-video call-stage-local-video--${pipCorner}${cameraOff ? ' is-off' : ''}${pipDragging ? ' is-dragging' : ''}`}
            style={pipStyle}
            autoPlay
            playsInline
            muted
            onPointerDown={onPipPointerDown}
            onPointerMove={onPipPointerMove}
            onPointerUp={onPipPointerUp}
            onPointerCancel={onPipPointerUp}
          />
        </>
      )}
      <div
        className={`call-stage-body${isVideo && phase === 'in_call' ? ' call-stage-body--video-dock' : ''}`}
      >
        {!(isVideo && phase === 'in_call') && (
          <p className="call-stage-label">{title}</p>
        )}
        {(!isVideo || phase !== 'in_call') && (
          <>
            <div
              className={`call-stage-avatar${phase === 'incoming' || phase === 'outgoing' ? ' call-stage-avatar--pulse' : ''}`}
              aria-hidden
            >
              <span className="call-stage-avatar-ring" />
              {initial}
            </div>
            <h2 className="call-stage-name">{peerName || 'Peer'}</h2>
          </>
        )}
        {isVideo && phase === 'in_call' && (
          <h2 className="call-stage-name call-stage-name--overlay">
            {peerName || 'Peer'}
          </h2>
        )}
        {phase === 'in_call' && elapsed && (
          <p className="call-stage-timer" aria-live="polite">
            {elapsed}
          </p>
        )}
        {subtitle && <p className="call-stage-sub">{subtitle}</p>}
        {error && <p className="call-stage-sub call-stage-error">{error}</p>}
        {!error && poorConnection && phase === 'in_call' && (
          <p className="call-stage-sub call-stage-quality">
            <SignalBars weak />
            <span>Poor connection</span>
          </p>
        )}
        {showHeadphonesTip && phase === 'in_call' && (
          <p className="call-stage-tip">
            Use headphones for the clearest audio
            <button
              type="button"
              className="call-stage-tip-dismiss"
              onClick={() => setShowHeadphonesTip(false)}
            >
              Got it
            </button>
          </p>
        )}

        <div className="call-stage-actions">
          {phase === 'incoming' && (
            <>
              <button
                type="button"
                className="call-stage-btn call-stage-btn--decline"
                onClick={() => {
                  hapticHeavy()
                  onReject()
                }}
              >
                Decline
              </button>
              <button
                type="button"
                className="call-stage-btn call-stage-btn--accept"
                onClick={() => {
                  hapticMedium()
                  onAccept()
                }}
                disabled={!offerReady}
              >
                {offerReady ? 'Accept' : 'Connecting…'}
              </button>
            </>
          )}
          {(phase === 'outgoing' || phase === 'in_call') && (
            <>
              {phase === 'in_call' && (
                <>
                  <button
                    type="button"
                    className={`call-stage-btn call-stage-btn--mute${muted ? ' is-on' : ''}`}
                    onClick={() => {
                      hapticLight()
                      onToggleMute()
                    }}
                  >
                    {muted ? 'Unmute' : 'Mute'}
                  </button>
                  {isVideo && onToggleCamera && (
                    <button
                      type="button"
                      className={`call-stage-btn call-stage-btn--cam${cameraOff ? ' is-on' : ''}`}
                      onClick={() => {
                        hapticLight()
                        onToggleCamera()
                      }}
                    >
                      {cameraOff ? 'Cam off' : 'Camera'}
                    </button>
                  )}
                  {/* Speaker only for voice — video always uses loudspeaker. */}
                  {!isVideo && speakerAvailable && onToggleSpeaker && (
                    <button
                      type="button"
                      className={`call-stage-btn call-stage-btn--speaker${speakerOn ? ' is-on' : ''}`}
                      onClick={() => {
                        hapticLight()
                        onToggleSpeaker()
                      }}
                    >
                      {speakerOn ? 'Speaker' : 'Earpiece'}
                    </button>
                  )}
                </>
              )}
              <button
                type="button"
                className="call-stage-btn call-stage-btn--end"
                onClick={() => {
                  hapticHeavy()
                  onEnd()
                }}
              >
                {phase === 'outgoing' ? 'Cancel' : 'End'}
              </button>
            </>
          )}
        </div>
        {onDismiss && phase === 'ended' && (
          <button type="button" className="ghost-btn" onClick={onDismiss}>
            Close
          </button>
        )}
      </div>
    </div>
  )
}
