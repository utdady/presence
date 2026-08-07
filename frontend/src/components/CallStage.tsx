import { useEffect, useRef } from 'react'
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
  error?: string | null
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

function isActivePhase(phase: string): boolean {
  return (
    phase === 'outgoing' ||
    phase === 'incoming' ||
    phase === 'in_call'
  )
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
  error,
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

  // Bind once while video UI is open — do not rebind on phase (that briefly
  // nulls the elements and drops remote video right after Accept).
  useEffect(() => {
    if (!open || !isVideo) return
    bindRemoteRef.current?.(remoteRef.current)
    bindLocalRef.current?.(localRef.current)
    return () => {
      bindRemoteRef.current?.(null)
      bindLocalRef.current?.(null)
    }
  }, [open, isVideo])

  if (!open || !isActivePhase(phase)) return null

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

  return (
    <div
      className={`call-stage${isVideo ? ' call-stage--video' : ''}${isVideo && phase === 'in_call' ? ' call-stage--video-live' : ''}`}
      role="dialog"
      aria-label={title}
    >
      <div className="call-stage-bg" />
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
            className={`call-stage-local-video${cameraOff ? ' is-off' : ''}`}
            autoPlay
            playsInline
            muted
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
            <div className="call-stage-avatar" aria-hidden>
              {(peerName || '?').slice(0, 1).toUpperCase()}
            </div>
            <h2 className="call-stage-name">{peerName || 'Peer'}</h2>
          </>
        )}
        {isVideo && phase === 'in_call' && (
          <h2 className="call-stage-name call-stage-name--overlay">
            {peerName || 'Peer'}
          </h2>
        )}
        {subtitle && <p className="call-stage-sub">{subtitle}</p>}
        {error && <p className="call-stage-sub call-stage-error">{error}</p>}

        <div className="call-stage-actions">
          {phase === 'incoming' && (
            <>
              <button
                type="button"
                className="call-stage-btn call-stage-btn--decline"
                onClick={onReject}
              >
                Decline
              </button>
              <button
                type="button"
                className="call-stage-btn call-stage-btn--accept"
                onClick={onAccept}
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
                    onClick={onToggleMute}
                  >
                    {muted ? 'Unmute' : 'Mute'}
                  </button>
                  {isVideo && onToggleCamera && (
                    <button
                      type="button"
                      className={`call-stage-btn call-stage-btn--cam${cameraOff ? ' is-on' : ''}`}
                      onClick={onToggleCamera}
                    >
                      {cameraOff ? 'Cam off' : 'Camera'}
                    </button>
                  )}
                  {/* Speaker only for voice — video always uses loudspeaker. */}
                  {!isVideo && speakerAvailable && onToggleSpeaker && (
                    <button
                      type="button"
                      className={`call-stage-btn call-stage-btn--speaker${speakerOn ? ' is-on' : ''}`}
                      onClick={onToggleSpeaker}
                    >
                      {speakerOn ? 'Speaker' : 'Earpiece'}
                    </button>
                  )}
                </>
              )}
              <button
                type="button"
                className="call-stage-btn call-stage-btn--end"
                onClick={onEnd}
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
