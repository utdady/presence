import { useEffect, useRef, useState, type FormEvent } from 'react'
import type { NearbyCallPhase, NearbyChatMessage } from './types'
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

const CHAT_PHASES = new Set<NearbyCallPhase>([
  'ready',
  'outgoing',
  'incoming',
  'in_call',
])

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
        Android Nearby (Bluetooth discovery + local Wi‑Fi). Voice and chat stay
        on-device while connected.
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
      {CHAT_PHASES.has(call.phase) && (
        <NearbyChatPanel
          messages={call.messages}
          peerName={call.remoteName}
          onSend={(text) => void call.sendChat(text)}
        />
      )}
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
        Presence; voice and chat are peer-to-peer (not stored on the server).
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
      {CHAT_PHASES.has(call.phase) && (
        <NearbyChatPanel
          messages={call.messages}
          peerName={call.remoteName}
          onSend={call.sendChat}
        />
      )}
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

function NearbyChatPanel({
  messages,
  peerName,
  onSend,
}: {
  messages: NearbyChatMessage[]
  peerName: string | null
  onSend: (text: string) => void
}) {
  const [draft, setDraft] = useState('')
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = listRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [messages])

  function submit(e: FormEvent) {
    e.preventDefault()
    const text = draft.trim()
    if (!text) return
    onSend(text)
    setDraft('')
  }

  return (
    <div className="nearby-chat">
      <p className="nearby-chat-label">
        Chat{peerName ? ` · ${peerName}` : ''}
      </p>
      <div className="nearby-chat-list" ref={listRef}>
        {messages.length === 0 ? (
          <p className="nearby-note">Messages only while you stay connected.</p>
        ) : (
          messages.map((m) => (
            <div
              key={m.id}
              className={`nearby-chat-bubble${m.mine ? ' nearby-chat-bubble--mine' : ''}`}
            >
              {!m.mine && (
                <span className="nearby-chat-from">{m.fromName}</span>
              )}
              <p>{m.text}</p>
            </div>
          ))
        )}
      </div>
      <form className="nearby-chat-compose" onSubmit={submit}>
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Message…"
          maxLength={2000}
          autoComplete="off"
        />
        <button type="submit" disabled={!draft.trim()}>
          Send
        </button>
      </form>
    </div>
  )
}
