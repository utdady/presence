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
  muted: boolean
  catchingUp?: boolean
  onAccept: () => void
  onReject: () => void
  onEnd: () => void
  onToggleMute: () => void
  onDismiss?: () => void
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
  muted,
  catchingUp,
  onAccept,
  onReject,
  onEnd,
  onToggleMute,
  onDismiss,
}: CallStageProps) {
  if (!open || !isActivePhase(phase)) return null

  const title =
    phase === 'incoming'
      ? 'Incoming call'
      : phase === 'outgoing'
        ? 'Calling…'
        : catchingUp
          ? 'Connected — catching up'
          : 'In call'

  return (
    <div className="call-stage" role="dialog" aria-label={title}>
      <div className="call-stage-bg" />
      <div className="call-stage-body">
        <p className="call-stage-label">{title}</p>
        <div className="call-stage-avatar" aria-hidden>
          {(peerName || '?').slice(0, 1).toUpperCase()}
        </div>
        <h2 className="call-stage-name">{peerName || 'Peer'}</h2>
        {subtitle && <p className="call-stage-sub">{subtitle}</p>}

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
              >
                Accept
              </button>
            </>
          )}
          {(phase === 'outgoing' || phase === 'in_call') && (
            <>
              {phase === 'in_call' && (
                <button
                  type="button"
                  className={`call-stage-btn call-stage-btn--mute${muted ? ' is-on' : ''}`}
                  onClick={onToggleMute}
                >
                  {muted ? 'Unmute' : 'Mute'}
                </button>
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
