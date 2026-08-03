import { useEffect, useRef, useState } from 'react'
import { nearbyTransport, type NearbyTransport } from './capability'
import { useLanNearbyCall } from './useLanNearbyCall'
import { useNearbyCall } from './useNearbyCall'

interface Props {
  userId: string
  displayName: string
  publicKey: string
  privateKey: string
  onBack: () => void
}

export function NearbyCallPage(props: Props) {
  const [transport, setTransport] = useState<NearbyTransport | null>(null)

  useEffect(() => {
    void nearbyTransport().then(setTransport)
  }, [])

  if (transport === null) {
    return (
      <div className="nearby-page">
        <header className="nearby-header">
          <button type="button" className="ghost-btn" onClick={props.onBack}>
            Back
          </button>
          <h1>Nearby</h1>
        </header>
        <p className="nearby-status">Checking device…</p>
      </div>
    )
  }

  if (transport === 'native') {
    return <NativeNearbyUI {...props} />
  }

  return <LanNearbyUI {...props} />
}

function NativeNearbyUI({
  userId,
  displayName,
  publicKey,
  privateKey,
  onBack,
}: Props) {
  const call = useNearbyCall({ userId, displayName, publicKey, privateKey })
  const audioRef = useRef<HTMLAudioElement>(null)

  useEffect(() => {
    call.setRemoteAudioEl(audioRef.current)
  }, [call])

  return (
    <div className="nearby-page">
      <header className="nearby-header">
        <button
          type="button"
          className="ghost-btn"
          onClick={() => {
            void call.stopScanning()
            onBack()
          }}
        >
          Back
        </button>
        <h1>Nearby</h1>
      </header>
      <audio ref={audioRef} autoPlay playsInline />
      <p className="nearby-status">{call.status || 'Idle'}</p>
      {call.error && <p className="form-error">{call.error}</p>}
      <p className="nearby-note" style={{ padding: '0 1.25rem' }}>
        Android Nearby (Bluetooth discovery + local Wi‑Fi).
      </p>

      {call.phase === 'idle' && (
        <div className="nearby-actions">
          <button type="button" onClick={() => void call.startScanning()}>
            Find nearby
          </button>
        </div>
      )}

      {(call.phase === 'scanning' || call.phase === 'connecting') && (
        <div className="nearby-panel">
          <ul className="nearby-peer-list">
            {call.peers.map((peer) => (
              <li key={peer.id}>
                <button
                  type="button"
                  className="friend-row"
                  onClick={() => void call.connectTo(peer)}
                >
                  <div className="friend-meta">
                    <span className="friend-name">{peer.name}</span>
                    <span className="friend-state">Tap to connect</span>
                  </div>
                </button>
              </li>
            ))}
            {call.peers.length === 0 && (
              <li className="nearby-note">Scanning…</li>
            )}
          </ul>
          <button
            type="button"
            className="ghost-btn"
            onClick={() => void call.stopScanning()}
          >
            Stop
          </button>
        </div>
      )}

      <CallControls call={call} />
    </div>
  )
}

function LanNearbyUI({
  userId,
  displayName,
  publicKey,
  privateKey,
  onBack,
}: Props) {
  const call = useLanNearbyCall({ userId, displayName, publicKey, privateKey })
  const audioRef = useRef<HTMLAudioElement>(null)
  const [joinCode, setJoinCode] = useState('')

  useEffect(() => {
    call.setRemoteAudioEl(audioRef.current)
  }, [call])

  return (
    <div className="nearby-page">
      <header className="nearby-header">
        <button
          type="button"
          className="ghost-btn"
          onClick={() => {
            call.leaveRoom()
            onBack()
          }}
        >
          Back
        </button>
        <h1>Nearby</h1>
      </header>
      <audio ref={audioRef} autoPlay playsInline />
      <p className="nearby-status">{call.status || 'Idle'}</p>
      {call.error && <p className="form-error">{call.error}</p>}
      <p className="nearby-note" style={{ padding: '0 1.25rem' }}>
        Web / PC: share a short code. Best on the same Wi‑Fi. Signaling uses
        Presence; call audio is peer-to-peer (not stored on the server).
      </p>

      {call.phase === 'idle' && (
        <div className="nearby-actions">
          <button type="button" onClick={() => void call.createRoom()}>
            Create room
          </button>
          <div className="invites-create">
            <input
              value={joinCode}
              onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
              placeholder="Room code"
              maxLength={8}
              autoCapitalize="characters"
            />
            <button type="button" onClick={() => void call.joinRoom(joinCode)}>
              Join
            </button>
          </div>
        </div>
      )}

      {(call.phase === 'scanning' || call.phase === 'connecting') && (
        <div className="nearby-panel nearby-ready">
          {call.roomCode && (
            <p className="empty-state-lead" style={{ letterSpacing: '0.2em' }}>
              {call.roomCode}
            </p>
          )}
          <p className="nearby-note">Waiting for the other device…</p>
          <button type="button" className="ghost-btn" onClick={call.leaveRoom}>
            Cancel
          </button>
        </div>
      )}

      <CallControls call={call} showLeave />
    </div>
  )
}

function CallControls({
  call,
  showLeave,
}: {
  call: {
    phase: string
    remoteName: string | null
    remoteFingerprint: string | null
    muted: boolean
    startCall: () => void | Promise<void>
    acceptCall: () => void | Promise<void>
    rejectCall: () => void
    endCall: () => void
    toggleMute: () => void
    leaveRoom?: () => void
  }
  showLeave?: boolean
}) {
  return (
    <>
      {call.phase === 'ready' && (
        <div className="nearby-panel nearby-ready">
          <p className="empty-state-lead">{call.remoteName ?? 'Peer'}</p>
          {call.remoteFingerprint && (
            <p className="nearby-fingerprint">Key {call.remoteFingerprint}</p>
          )}
          <div className="nearby-actions-row">
            <button type="button" onClick={() => void call.startCall()}>
              Call
            </button>
            {showLeave && call.leaveRoom && (
              <button
                type="button"
                className="ghost-btn"
                onClick={call.leaveRoom}
              >
                Leave
              </button>
            )}
          </div>
        </div>
      )}

      {call.phase === 'outgoing' && (
        <div className="nearby-panel nearby-ready">
          <p className="empty-state-lead">Calling…</p>
          <button type="button" onClick={call.endCall}>
            Cancel
          </button>
        </div>
      )}

      {call.phase === 'incoming' && (
        <div className="nearby-panel nearby-ready">
          <p className="empty-state-lead">
            Incoming · {call.remoteName ?? 'Someone'}
          </p>
          <div className="nearby-actions-row">
            <button type="button" onClick={() => void call.acceptCall()}>
              Accept
            </button>
            <button type="button" className="ghost-btn" onClick={call.rejectCall}>
              Decline
            </button>
          </div>
        </div>
      )}

      {call.phase === 'in_call' && (
        <div className="nearby-panel nearby-ready">
          <p className="empty-state-lead">
            In call · {call.remoteName ?? 'Peer'}
          </p>
          <div className="nearby-actions-row">
            <button type="button" onClick={call.toggleMute}>
              {call.muted ? 'Unmute' : 'Mute'}
            </button>
            <button type="button" onClick={call.endCall}>
              End
            </button>
          </div>
        </div>
      )}
    </>
  )
}